/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Joi from "@hapi/joi"
import normalize = require("normalize-path")
import { sortBy, omit } from "lodash"
import { createHash } from "crypto"
import { validateSchema } from "../config/validation"
import { join, relative, isAbsolute } from "path"
import { GARDEN_VERSIONFILE_NAME as GARDEN_TREEVERSION_FILENAME } from "../constants"
import { pathExists, readFile, writeFile } from "fs-extra"
import { ConfigurationError } from "../exceptions"
import { ExternalSourceType, getRemoteSourcesDirname, getRemoteSourceRelPath } from "../util/ext-source-util"
import { ModuleConfig, serializeConfig } from "../config/module"
import { LogEntry } from "../logger/log-entry"
import { treeVersionSchema, moduleVersionSchema } from "../config/common"
import { dedent } from "../util/string"
import { fixedProjectExcludes } from "../util/fs"
import { TreeCache } from "../cache"
import { getModuleCacheContext } from "../types/module"
import { ServiceConfig } from "../config/service"
import { TaskConfig } from "../config/task"
import { TestConfig } from "../config/test"
import { GardenModule } from "../types/module"
import { emitWarning } from "../warnings"
import { validateInstall } from "../util/validateInstall"

const AsyncLock = require("async-lock")
const scanLock = new AsyncLock()

export const versionStringPrefix = "v-"
export const NEW_MODULE_VERSION = "0000000000"
const fileCountWarningThreshold = 10000

const minGitVersion = "2.14.0"
export const gitVersionRegex = /git\s+version\s+v?(\d+.\d+.\d+)/

/**
 * throws if no git is installed or version is too old
 */
export async function validateGitInstall() {
  await validateInstall({
    minVersion: minGitVersion,
    name: "git",
    versionCommand: { cmd: "git", args: ["--version"] },
    versionRegex: gitVersionRegex,
  })
}

export interface TreeVersion {
  contentHash: string
  files: string[]
}

export interface TreeVersions {
  [moduleName: string]: TreeVersion
}

export interface ModuleVersion {
  versionString: string
  dependencyVersions: DependencyVersions
  files: string[]
}

export interface NamedModuleVersion extends ModuleVersion {
  name: string
}

export interface DependencyVersions {
  [moduleName: string]: string
}

export interface NamedTreeVersion extends TreeVersion {
  name: string
}

export interface VcsInfo {
  branch: string
  commitHash: string
  originUrl: string
}

export interface GetFilesParams {
  log: LogEntry
  path: string
  pathDescription?: string
  include?: string[]
  exclude?: string[]
  filter?: (path: string) => boolean
  failOnPrompt?: boolean
}

export interface RemoteSourceParams {
  url: string
  name: string
  sourceType: ExternalSourceType
  log: LogEntry
  failOnPrompt?: boolean
}

export interface VcsFile {
  path: string
  hash: string
}

export abstract class VcsHandler {
  constructor(
    protected projectRoot: string,
    protected gardenDirPath: string,
    protected ignoreFiles: string[],
    private cache: TreeCache
  ) {}

  abstract name: string
  abstract getRepoRoot(log: LogEntry, path: string): Promise<string>
  abstract getFiles(params: GetFilesParams): Promise<VcsFile[]>
  abstract ensureRemoteSource(params: RemoteSourceParams): Promise<string>
  abstract updateRemoteSource(params: RemoteSourceParams): Promise<void>
  abstract getPathInfo(log: LogEntry, path: string): Promise<VcsInfo>

  async getTreeVersion(
    log: LogEntry,
    projectName: string,
    moduleConfig: ModuleConfig,
    force = false
  ): Promise<TreeVersion> {
    const configPath = moduleConfig.configPath

    // Apply project root excludes if the module config is in the project root and `include` isn't set
    const exclude =
      moduleConfig.path === this.projectRoot && !moduleConfig.include
        ? [...(moduleConfig.exclude || []), ...fixedProjectExcludes]
        : moduleConfig.exclude

    let result: TreeVersion = { contentHash: NEW_MODULE_VERSION, files: [] }

    const cacheKey = getModuleTreeCacheKey(moduleConfig)

    // Make sure we don't concurrently scan the exact same context
    await scanLock.acquire(cacheKey.join(":"), async () => {
      if (!force) {
        const cached = this.cache.get(log, cacheKey)
        if (cached) {
          log.silly(`Got cached tree version for module ${moduleConfig.name} (key ${cacheKey})`)
          result = cached
          return
        }
      }

      // No need to scan for files if nothing should be included
      if (!(moduleConfig.include && moduleConfig.include.length === 0)) {
        let files = await this.getFiles({
          log,
          path: moduleConfig.path,
          pathDescription: "module root",
          include: moduleConfig.include,
          exclude,
        })

        if (files.length > fileCountWarningThreshold) {
          await emitWarning({
            key: `${projectName}-filecount-${moduleConfig.name}`,
            log,
            message: dedent`
              Large number of files (${files.length}) found in module ${moduleConfig.name}. You may need to configure file exclusions.
              See https://docs.garden.io/using-garden/configuration-overview#including-excluding-files-and-directories for details.
            `,
          })
        }

        files = sortBy(files, "path")
          // Don't include the config file in the file list
          .filter((f) => !configPath || f.path !== configPath)

        result.contentHash = hashStrings(files.map((f) => f.hash))
        result.files = files.map((f) => f.path)
      }

      this.cache.set(log, cacheKey, result, getModuleCacheContext(moduleConfig))
    })

    return result
  }

  async resolveTreeVersion(log: LogEntry, projectName: string, moduleConfig: ModuleConfig): Promise<TreeVersion> {
    // the version file is used internally to specify versions outside of source control
    const versionFilePath = join(moduleConfig.path, GARDEN_TREEVERSION_FILENAME)
    const fileVersion = await readTreeVersionFile(versionFilePath)
    return fileVersion || (await this.getTreeVersion(log, projectName, moduleConfig))
  }

  getRemoteSourcesDirname(type: ExternalSourceType) {
    return getRemoteSourcesDirname(type)
  }

  /**
   * Returns the path to the remote source directory, relative to the project level Garden directory (.garden)
   */
  getRemoteSourceRelPath(name: string, url: string, sourceType: ExternalSourceType) {
    return getRemoteSourceRelPath({ name, url, sourceType })
  }
}

async function readVersionFile(path: string, schema: Joi.Schema): Promise<any> {
  if (!(await pathExists(path))) {
    return null
  }

  // this is used internally to specify version outside of source control
  const versionFileContents = (await readFile(path)).toString().trim()

  if (!versionFileContents) {
    return null
  }

  try {
    return validateSchema(JSON.parse(versionFileContents), schema)
  } catch (error) {
    throw new ConfigurationError(`Unable to parse ${path} as valid version file`, {
      path,
      versionFileContents,
      error,
    })
  }
}

export async function readTreeVersionFile(path: string): Promise<TreeVersion | null> {
  return readVersionFile(path, treeVersionSchema())
}

export async function readModuleVersionFile(path: string): Promise<ModuleVersion | null> {
  return readVersionFile(path, moduleVersionSchema())
}

/**
 * Writes a normalized TreeVersion file to the specified directory
 *
 * @param dir The directory to write the file to
 * @param version The TreeVersion for the directory
 */
export async function writeTreeVersionFile(dir: string, version: TreeVersion) {
  const processed = {
    ...version,
    files: version.files
      // Always write relative paths, normalized to POSIX style
      .map((f) => normalize(isAbsolute(f) ? relative(dir, f) : f))
      .filter((f) => f !== GARDEN_TREEVERSION_FILENAME),
  }
  const path = join(dir, GARDEN_TREEVERSION_FILENAME)
  await writeFile(path, JSON.stringify(processed, null, 4) + "\n")
}

export async function writeModuleVersionFile(path: string, version: ModuleVersion) {
  await writeFile(path, JSON.stringify(version, null, 4) + "\n")
}

/**
 * We prefix with "v-" to prevent this.version from being read as a number when only a prefix of the
 * commit hash is used, and that prefix consists of only numbers. This can cause errors in certain contexts
 * when the version string is used in template variables in configuration files.
 */
export function getModuleVersionString(
  moduleConfig: ModuleConfig,
  treeVersion: NamedTreeVersion,
  dependencyModuleVersions: NamedModuleVersion[]
) {
  // TODO: allow overriding the prefix
  return `${versionStringPrefix}${hashModuleVersion(moduleConfig, treeVersion, dependencyModuleVersions)}`
}

/**
 * Compute the version of the given module, based on its configuration and the versions of its build dependencies.
 * The versions argument should consist of moduleConfig's tree version, and the tree versions of its dependencies.
 */
export function hashModuleVersion(
  moduleConfig: ModuleConfig,
  treeVersion: NamedTreeVersion,
  dependencyModuleVersions: NamedModuleVersion[]
) {
  // If a build config is provided, we use that.
  // Otherwise, we use the full module config, omitting the configPath, path, and outputs fields, as well as individual
  // entity configuration fields, as these often vary between environments and runtimes but are unlikely to impact the
  // build output.
  const configToHash =
    moduleConfig.buildConfig ||
    omit(moduleConfig, ["configPath", "path", "outputs", "serviceConfigs", "taskConfigs", "testConfigs"])

  const configString = serializeConfig(configToHash)

  const versionStrings = sortBy(
    [[treeVersion.name, treeVersion.contentHash], ...dependencyModuleVersions.map((v) => [v.name, v.versionString])],
    (vs) => vs[0]
  ).map((vs) => vs[1])

  return hashStrings([configString, ...versionStrings])
}

/**
 * Return the version string for the given Stack Graph entity (i.e. service, task or test).
 * It is simply a hash of the module version and the configuration of the entity.
 *
 * @param module        The module containing the entity in question
 * @param entityConfig  The configuration of the entity
 */
export function getEntityVersion(module: GardenModule, entityConfig: ServiceConfig | TaskConfig | TestConfig) {
  const configString = serializeConfig(entityConfig)
  return `${versionStringPrefix}${hashStrings([module.version.versionString, configString])}`
}

export function hashStrings(hashes: string[]) {
  const versionHash = createHash("sha256")
  versionHash.update(hashes.join("."))
  return versionHash.digest("hex").slice(0, 10)
}

export function getModuleTreeCacheKey(moduleConfig: ModuleConfig) {
  const cacheKey = [moduleConfig.path]

  if (moduleConfig.include) {
    cacheKey.push("include", hashStrings(moduleConfig.include))
  }
  if (moduleConfig.exclude) {
    cacheKey.push("exclude", hashStrings(moduleConfig.exclude))
  }

  return cacheKey
}
