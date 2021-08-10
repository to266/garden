/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const AsyncLock = require("async-lock")
import chalk from "chalk"
import { join } from "path"
import { mkdirp, pathExists, remove, removeSync } from "fs-extra"
import respawn from "respawn"
import { LogEntry } from "../../logger/log-entry"
import { PluginToolSpec } from "../../types/plugin/tools"
import { PluginTool } from "../../util/ext-tools"
import { makeTempDir, TempDirectory } from "../../util/fs"
import { registerCleanupFunction, sleep } from "../../util/util"
import { GardenBaseError } from "../../exceptions"

const maxRestarts = 10
const monitorDelay = 2000
const mutagenLogSection = "<mutagen>"

let daemonProc: any
let mutagenTmp: TempDirectory

export const mutagenModeMap = {
  "one-way": "one-way-safe",
  "one-way-replica": "one-way-replica",
  "two-way": "two-way-safe",
}

interface SyncConfig {
  alpha: string
  beta: string
  mode: keyof typeof mutagenModeMap
  ignore: string[]
}

interface ActiveSync {
  sourceDescription: string
  targetDescription: string
  logSection: string
  sourceConnected: boolean
  targetConnected: boolean
  config: SyncConfig
  lastProblems: string[]
  lastSyncCount: number
}

let activeSyncs: { [key: string]: ActiveSync } = {}

export class MutagenError extends GardenBaseError {
  type = "mutagen"
}

export const mutagenConfigLock = new AsyncLock()

registerCleanupFunction("kill-sync-daaemon", () => {
  stopDaemonProc()
  mutagenTmp && removeSync(mutagenTmp.path)
})

export async function killSyncDaemon(clearTmpDir = true) {
  stopDaemonProc()
  if (mutagenTmp) {
    await remove(join(mutagenTmp.path, "mutagen.yml.lock"))
  }

  if (clearTmpDir) {
    mutagenTmp && (await remove(mutagenTmp.path))
  }

  activeSyncs = {}
}

function stopDaemonProc() {
  try {
    daemonProc?.stop()
    daemonProc = undefined
  } catch {}
}

export async function ensureMutagenDaemon(log: LogEntry) {
  return mutagenConfigLock.acquire("start-daemon", async () => {
    if (!mutagenTmp) {
      mutagenTmp = await makeTempDir()
    }

    const dataDir = mutagenTmp.path

    if (daemonProc && daemonProc.status === "running") {
      return dataDir
    }

    const mutagenPath = await mutagen.getPath(log)

    await mkdirp(dataDir)

    daemonProc = respawn([mutagenPath, "daemon", "run"], {
      cwd: dataDir,
      name: "mutagen",
      env: {
        MUTAGEN_DATA_DIRECTORY: dataDir,
        MUTAGEN_LOG_LEVEL: "debug",
      },
      maxRestarts,
      sleep: 3000,
      kill: 500,
      stdio: "pipe",
      fork: false,
    })

    const crashMessage = `Synchronization daemon has crashed ${maxRestarts} times. Aborting.`

    daemonProc.on("crash", () => {
      log.warn(chalk.yellow(crashMessage))
    })

    daemonProc.on("exit", (code: number) => {
      if (code !== 0) {
        log.warn({
          symbol: "empty",
          section: mutagenLogSection,
          msg: chalk.yellow(`Synchronization daemon exited with code ${code}.`),
        })
        // Remove the lock file
        const daemonLockFilePath = join(dataDir, "daemon", "daemon.lock")
        removeSync(daemonLockFilePath)
      }
    })

    const handleOutput = (data: Buffer) => {
      const str = data.toString().trim()
      // This is a little dumb, to detect if the log line starts with a timestamp, but ya know...
      // it'll basically work for the next 979 years :P.
      const msg = chalk.gray(str.startsWith("2") ? str.split(" ").slice(3).join(" ") : str)
      if (msg.includes("Unable")) {
        log.warn({ symbol: "warning", section: mutagenLogSection, msg })
      } else {
        log.silly({ symbol: "empty", section: mutagenLogSection, msg })
      }
    }

    daemonProc.on("stdout", handleOutput)
    daemonProc.on("stderr", handleOutput)

    return new Promise<string>((resolve, reject) => {
      let resolved = false

      daemonProc.on("spawn", () => {
        if (resolved) {
          log.info({
            symbol: "empty",
            section: mutagenLogSection,
            msg: chalk.green("Synchronization daemon re-started"),
          })
        }
      })

      daemonProc.once("spawn", () => {
        setTimeout(() => {
          if (daemonProc.status === "running") {
            resolved = true
            resolve(dataDir)
          }
        }, 500)
      })

      daemonProc.once("crash", () => {
        if (!resolved) {
          reject(crashMessage)
        }
      })

      daemonProc.start()
    })
  })
}

export async function execMutagenCommand(log: LogEntry, args: string[]) {
  let dataDir = await ensureMutagenDaemon(log)

  let loops = 0
  const maxRetries = 10

  while (true) {
    // Keep trying for a bit in case we can't connect to the daemon
    try {
      const res = await mutagen.exec({
        cwd: dataDir,
        args,
        log,
        env: {
          MUTAGEN_DATA_DIRECTORY: dataDir,
        },
      })
      startMutagenMonitor(log)
      return res
    } catch (err) {
      const unableToConnect = err.message.match(/unable to connect to daemon/)

      if (unableToConnect && loops < 10) {
        loops += 1
        if (unableToConnect) {
          log.warn({
            symbol: "empty",
            section: mutagenLogSection,
            msg: chalk.gray(`Could not connect to sync daemon, retrying (attempt ${loops}/${maxRetries})...`),
          })
        }
        await killSyncDaemon(false)
        await sleep(2000 + loops * 500)
        dataDir = await ensureMutagenDaemon(log)
      } else {
        throw err
      }
    }
  }
}

interface ScanProblem {
  path: string
  error: string
}

interface ConflictChange {
  path: string
  new?: {
    kind: number
    digest?: string
    target?: string
    executable?: boolean
  }
}

interface SyncConflict {
  root: string
  alphaChanges?: ConflictChange[]
  betaChanges?: ConflictChange[]
}

interface SyncListEntry {
  session: {
    identifier: string
    version: number
    creationTime: {
      seconds: number
      nanos: number
    }
    creatingVersionMinor: number
    alpha: {
      path: string
    }
    beta: {
      path: string
    }
    configuration: {
      synchronizationMode: number
    }
    configurationAlpha: any
    configurationBeta: any
    name: string
    paused?: boolean
  }
  status?: number
  alphaConnected?: boolean
  betaConnected?: boolean
  alphaScanProblems?: ScanProblem[]
  betaScanProblems?: ScanProblem[]
  successfulSynchronizationCycles?: number
  conflicts?: SyncConflict[]
  excludedConflicts?: number
}

let monitorInterval: NodeJS.Timeout

function checkMutagen(log: LogEntry) {
  getActiveMutagenSyncs(log)
    .then((syncs) => {
      for (const sync of syncs) {
        const problems: string[] = [
          ...(sync.alphaScanProblems || []).map((p) => `Error scanning sync source, path ${p.path}: ${p.error}`),
          ...(sync.betaScanProblems || []).map((p) => `Error scanning sync target, path ${p.path}: ${p.error}`),
        ]

        const activeSync = activeSyncs[sync.session.name]
        if (!activeSync) {
          continue
        }

        const { logSection: section } = activeSync

        for (const problem of problems) {
          if (!activeSync.lastProblems.includes(problem)) {
            log.warn({ symbol: "warning", section, msg: chalk.yellow(problem) })
          }
        }

        if (sync.alphaConnected && !activeSync.sourceConnected) {
          log.info({
            symbol: "info",
            section,
            msg: chalk.gray(`Connected to sync source ${activeSync.sourceDescription}`),
          })
          activeSync.sourceConnected = true
        }

        if (sync.betaConnected && !activeSync.targetConnected) {
          log.info({
            symbol: "success",
            section,
            msg: chalk.gray(`Connected to sync target ${activeSync.targetDescription}`),
          })
          activeSync.targetConnected = true
        }

        const syncCount = sync.successfulSynchronizationCycles || 0
        const description = `from ${activeSync.sourceDescription} to ${activeSync.targetDescription}`

        if (syncCount > activeSync.lastSyncCount) {
          if (activeSync.lastSyncCount === 0) {
            log.info({
              symbol: "success",
              section,
              msg: chalk.gray(`Completed initial sync ${description}`),
            })
          } else {
            log.info({ symbol: "info", section, msg: chalk.gray(`Synchronized ${description}`) })
          }
        }

        activeSync.lastProblems = problems
        activeSync.lastSyncCount = syncCount
      }
    })
    .catch((err) => {
      log.debug({
        symbol: "warning",
        section: mutagenLogSection,
        msg: "Unable to get status from sync daemon: " + err.message,
      })
    })
}

export function startMutagenMonitor(log: LogEntry) {
  if (!monitorInterval) {
    monitorInterval = setInterval(() => checkMutagen(log), monitorDelay)
  }
}

/**
 * List the currently active syncs in the mutagen daemon.
 */
export async function getActiveMutagenSyncs(log: LogEntry): Promise<SyncListEntry[]> {
  const res = await execMutagenCommand(log, ["sync", "list", "--output=json", "--auto-start=false"])

  // TODO: validate further
  let parsed: any = {}

  try {
    parsed = JSON.parse(res.stdout)
  } catch (err) {
    throw new MutagenError(`Could not parse response from mutagen sync list: ${res.stdout}`, { res })
  }

  if (!parsed.sessions) {
    throw new MutagenError(`Unexpected response from mutagen sync list: ${parsed}`, { res, parsed })
  }

  return parsed.sessions
}

/**
 * Make sure the specified sync is active. Does nothing if a sync is already active with the same key.
 * (When configuration changes, the whole daemon is reset).
 */
export async function ensureMutagenSync({
  log,
  logSection,
  key,
  sourceDescription,
  targetDescription,
  config,
}: {
  log: LogEntry
  logSection: string
  key: string
  sourceDescription: string
  targetDescription: string
  config: SyncConfig
}) {
  if (activeSyncs[key]) {
    return
  }

  return mutagenConfigLock.acquire("configure", async () => {
    const active = await getActiveMutagenSyncs(log)
    const existing = active.find((s: any) => s.name === key)

    if (!existing) {
      await execMutagenCommand(log, ["sync", "create", config.alpha, config.beta, "--name", key, "--auto-start=false"])
      activeSyncs[key] = {
        sourceDescription,
        targetDescription,
        logSection,
        sourceConnected: await isValidLocalPath(config.alpha),
        targetConnected: await isValidLocalPath(config.beta),
        config,
        lastProblems: [],
        lastSyncCount: 0,
      }
    }
  })
}

/**
 * Remove the specified sync (by name) from the sync daemon.
 */
export async function terminateMutagenSync(log: LogEntry, key: string) {
  return mutagenConfigLock.acquire("configure", async () => {
    try {
      await execMutagenCommand(log, ["sync", "delete", key, "--auto-start=false"])
    } catch (err) {
      // Ignore other errors, which should mean the sync wasn't found
      if (err.message.includes("unable to connect to daemon")) {
        throw err
      }
    }
  })
}

export const mutagenCliSpec: PluginToolSpec = {
  name: "mutagen",
  description: "The mutagen synchronization tool.",
  type: "binary",
  _includeInGardenImage: false,
  builds: [
    {
      platform: "darwin",
      architecture: "amd64",
      url:
        "https://github.com/garden-io/mutagen/releases/download/v0.12.0-garden-alpha2/mutagen_darwin_amd64_v0.12.0-beta3.tar.gz",
      sha256: "e31cebb5c4cbd1a1320e56b111416389e9eed911233b40c93801547c1eec0563",
      extract: {
        format: "tar",
        targetPath: "mutagen",
      },
    },
    {
      platform: "linux",
      architecture: "amd64",
      url:
        "https://github.com/garden-io/mutagen/releases/download/v0.12.0-garden-alpha2/mutagen_linux_amd64_v0.12.0-beta3.tar.gz",
      sha256: "09a0dbccbbd784324707ba12002a6bc90395f0cd73daab83d6cda7432b4973f3",
      extract: {
        format: "tar",
        targetPath: "mutagen",
      },
    },
    {
      platform: "windows",
      architecture: "amd64",
      url:
        "https://github.com/garden-io/mutagen/releases/download/v0.12.0-garden-alpha2/mutagen_windows_amd64_v0.12.0-beta3.zip",
      sha256: "9482646380a443b72aa38b3569c71c73d91ddde7c57a10de3d48b0b727cb8bff",
      extract: {
        format: "tar",
        targetPath: "mutagen.exe",
      },
    },
  ],
}

const mutagen = new PluginTool(mutagenCliSpec)

/**
 * Returns true if the given sync point is a filesystem path that exists.
 */
async function isValidLocalPath(syncPoint: string) {
  return pathExists(syncPoint)
}
