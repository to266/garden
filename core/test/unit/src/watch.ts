/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve, join } from "path"
import { expect } from "chai"
import pEvent from "p-event"

import {
  TestGarden,
  dataDir,
  makeTestGarden,
  withDefaultGlobalOpts,
  makeExtModuleSourcesGarden,
  resetLocalConfig,
  makeExtProjectSourcesGarden,
} from "../../helpers"
import { CacheContext, pathToCacheContext } from "../../../src/cache"
import { remove, pathExists, writeFile } from "fs-extra"
import { LinkModuleCommand } from "../../../src/commands/link/module"
import { LinkSourceCommand } from "../../../src/commands/link/source"
import { sleep } from "../../../src/util/util"
import { Garden } from "../../../src/garden"

function emitEvent(garden: TestGarden, name: string, payload: any) {
  garden["watcher"]["watcher"]!.emit(name, payload)
}

describe("Watcher", () => {
  let garden: TestGarden
  let modulePath: string
  let doubleModulePath: string
  let includeModulePath: string
  let moduleContext: CacheContext

  before(async () => {
    garden = await makeTestGarden(resolve(dataDir, "test-project-watch"), { noTempDir: true, noCache: true })
    modulePath = resolve(garden.projectRoot, "module-a")
    doubleModulePath = resolve(garden.projectRoot, "double-module")
    includeModulePath = resolve(garden.projectRoot, "with-include")
    moduleContext = pathToCacheContext(modulePath)
    await garden.startWatcher({
      graph: await garden.getConfigGraph({ log: garden.log, emit: false, noCache: true }),
      bufferInterval: 10,
    })
    await waitUntilReady(garden)
  })

  beforeEach(async () => {
    garden.events.clearLog()
    garden["watcher"]["addBuffer"] = {}
  })

  afterEach(async () => {
    // Wait for processing to complete
    await waitForProcessing()
  })

  after(async () => {
    await garden.close()
  })

  async function waitUntilReady(_garden: Garden) {
    if (_garden["watcher"].ready) {
      return
    }
    return pEvent(_garden["watcher"], "ready", { timeout: 5000 })
  }

  async function waitForEvent(name: string) {
    return pEvent(<any>garden.events, name, { timeout: 5000 })
  }

  async function waitForProcessing() {
    while (garden["watcher"].processing) {
      await sleep(100)
    }
  }

  function getEventLog() {
    // Filter out task events, which come from module resolution
    return garden.events.eventLog.filter((e) => !e.name.startsWith("task"))
  }

  function getConfigFilePath(path: string) {
    return join(path, "garden.yml")
  }

  it("should emit a moduleConfigChanged changed event when module config is changed", async () => {
    const path = getConfigFilePath(modulePath)
    emitEvent(garden, "change", path)
    expect(getEventLog()).to.eql([{ name: "moduleConfigChanged", payload: { names: ["module-a"], path } }])
  })

  it("should emit a moduleConfigChanged event when module config is changed and include field is set", async () => {
    const path = getConfigFilePath(includeModulePath)
    emitEvent(garden, "change", path)
    expect(getEventLog()).to.eql([
      {
        name: "moduleConfigChanged",
        payload: { names: ["with-include"], path },
      },
    ])
  })

  it("should clear all module caches when a module config is changed", async () => {
    const path = getConfigFilePath(modulePath)
    emitEvent(garden, "change", path)
    expect(garden.cache.getByContext(moduleContext)).to.eql(new Map())
  })

  it("should emit a projectConfigChanged changed event when project config is changed", async () => {
    const path = getConfigFilePath(garden.projectRoot)
    emitEvent(garden, "change", path)
    expect(getEventLog()).to.eql([{ name: "projectConfigChanged", payload: {} }])
  })

  it("should emit a projectConfigChanged changed event when project config is removed", async () => {
    const path = getConfigFilePath(garden.projectRoot)
    emitEvent(garden, "unlink", path)
    await waitForEvent("projectConfigChanged")
    expect(getEventLog()).to.eql([{ name: "projectConfigChanged", payload: {} }])
  })

  it("should emit a projectConfigChanged changed event when ignore files are changed", async () => {
    const path = join(getConfigFilePath(garden.projectRoot), ".gardenignore")
    emitEvent(garden, "change", path)
    expect(getEventLog()).to.eql([{ name: "projectConfigChanged", payload: {} }])
  })

  it("should clear all module caches when project config is changed", async () => {
    const path = getConfigFilePath(garden.projectRoot)
    emitEvent(garden, "change", path)
    expect(garden.cache.getByContext(moduleContext)).to.eql(new Map())
  })

  it("should emit a configAdded event when adding a garden.yml file", async () => {
    const path = getConfigFilePath(join(garden.projectRoot, "module-b"))
    emitEvent(garden, "add", path)
    expect(await waitForEvent("configAdded")).to.eql({ path })
  })

  it("should emit a configRemoved event when removing a garden.yml file", async () => {
    const path = getConfigFilePath(join(garden.projectRoot, "module-a"))
    emitEvent(garden, "unlink", path)
    await waitForEvent("configRemoved")
    expect(getEventLog()).to.eql([{ name: "configRemoved", payload: { path } }])
  })

  context("should emit a moduleSourcesChanged event", () => {
    it("containing the module's name when one of its files is changed", async () => {
      const pathsChanged = [resolve(modulePath, "foo.txt")]
      emitEvent(garden, "change", pathsChanged[0])
      expect(getEventLog()).to.eql([
        {
          name: "moduleSourcesChanged",
          payload: { names: ["module-a"], pathsChanged },
        },
      ])
    })

    it("if a file is changed and it matches a module's include list", async () => {
      const pathsChanged = [resolve(includeModulePath, "subdir", "foo2.txt")]
      emitEvent(garden, "change", pathsChanged[0])
      expect(getEventLog()).to.eql([
        {
          name: "moduleSourcesChanged",
          payload: { names: ["with-include"], pathsChanged },
        },
      ])
    })

    it("if a file is added to a module", async () => {
      const path = resolve(modulePath, "new.txt")
      try {
        await writeFile(path, "foo")
        expect(await waitForEvent("moduleSourcesChanged")).to.eql({
          names: ["module-a"],
          pathsChanged: [path],
        })
      } finally {
        const exists = await pathExists(path)
        exists && (await remove(path))
      }
    })

    it("containing both modules' names when a source file is changed for two co-located modules", async () => {
      const pathsChanged = [resolve(doubleModulePath, "foo.txt")]
      emitEvent(garden, "change", pathsChanged[0])
      const event = getEventLog()[0]
      event.payload.names = event.payload.names.sort()
      expect(event).to.eql({
        name: "moduleSourcesChanged",
        payload: { names: ["module-b", "module-c"], pathsChanged },
      })
    })
  })

  it("should not emit moduleSourcesChanged if file is changed and matches the modules.exclude list", async () => {
    const pathChanged = resolve(includeModulePath, "project-excluded.txt")
    emitEvent(garden, "change", pathChanged)
    expect(getEventLog()).to.eql([])
  })

  it("should not emit moduleSourcesChanged if file is changed and doesn't match module's include list", async () => {
    const pathChanged = resolve(includeModulePath, "foo.txt")
    emitEvent(garden, "change", pathChanged)
    expect(getEventLog()).to.eql([])
  })

  it("should not emit moduleSourcesChanged if file is changed and it's in a gardenignore in the module", async () => {
    const pathChanged = resolve(modulePath, "module-excluded.txt")
    emitEvent(garden, "change", pathChanged)
    expect(getEventLog()).to.eql([])
  })

  it("should not emit moduleSourcesChanged if file is changed and it's in a gardenignore in the project", async () => {
    const pathChanged = resolve(modulePath, "gardenignore-excluded.txt")
    emitEvent(garden, "change", pathChanged)
    expect(getEventLog()).to.eql([])
  })

  it("should clear a module's cache when a module file is changed", async () => {
    const pathChanged = resolve(modulePath, "foo.txt")
    emitEvent(garden, "change", pathChanged)
    expect(garden.cache.getByContext(moduleContext)).to.eql(new Map())
  })

  it("should emit a configAdded event when a directory is added that contains a garden.yml file", async () => {
    emitEvent(garden, "addDir", modulePath)
    expect(await waitForEvent("configAdded")).to.eql({
      path: getConfigFilePath(modulePath),
    })
  })

  it("should emit a moduleSourcesChanged event when a directory is added under a module directory", async () => {
    const pathsChanged = [resolve(modulePath, "subdir")]
    emitEvent(garden, "addDir", pathsChanged[0])
    expect(await waitForEvent("moduleSourcesChanged")).to.eql({
      names: ["module-a"],
      pathsChanged,
    })
  })

  it("should clear a module's cache when a directory is added under a module directory", async () => {
    const pathChanged = resolve(modulePath, "subdir")
    emitEvent(garden, "addDir", pathChanged)
    await waitForEvent("moduleSourcesChanged")
    expect(garden.cache.getByContext(moduleContext)).to.eql(new Map())
  })

  it("should emit a moduleRemoved event if a directory containing a module is removed", async () => {
    emitEvent(garden, "unlinkDir", modulePath)
    await waitForEvent("moduleRemoved")
    expect(getEventLog()).to.eql([{ name: "moduleRemoved", payload: {} }])
  })

  it("should emit a moduleSourcesChanged event if a directory within a module is removed", async () => {
    const pathsChanged = [resolve(modulePath, "subdir")]
    emitEvent(garden, "unlinkDir", pathsChanged[0])
    await waitForEvent("moduleSourcesChanged")
    expect(getEventLog()).to.eql([
      {
        name: "moduleSourcesChanged",
        payload: { names: ["module-a"], pathsChanged },
      },
    ])
  })

  it("should emit a moduleSourcesChanged event if a module's file is removed", async () => {
    const pathsChanged = [resolve(modulePath, "foo.txt")]
    emitEvent(garden, "unlink", pathsChanged[0])
    await waitForEvent("moduleSourcesChanged")
    expect(getEventLog()).to.eql([
      {
        name: "moduleSourcesChanged",
        payload: { names: ["module-a"], pathsChanged },
      },
    ])
  })

  // Note: This is to ensure correct handling of version file lists and cache invalidation
  it("should correctly handle removing a file and then re-adding it", async () => {
    const pathsChanged = [resolve(modulePath, "foo.txt")]
    emitEvent(garden, "unlink", pathsChanged[0])
    await waitForEvent("moduleSourcesChanged")
    expect(getEventLog()).to.eql([
      {
        name: "moduleSourcesChanged",
        payload: { names: ["module-a"], pathsChanged },
      },
    ])

    garden.events.eventLog = []

    emitEvent(garden, "add", pathsChanged[0])
    await waitForEvent("moduleSourcesChanged")
    expect(getEventLog()).to.eql([
      {
        name: "moduleSourcesChanged",
        payload: { names: ["module-a"], pathsChanged },
      },
    ])
  })

  context("linked module sources", () => {
    let localModuleSourceDir: string
    let localModulePathA: string
    let localModulePathB: string

    before(async () => {
      await garden.close()

      garden = await makeExtModuleSourcesGarden({ noCache: true })

      localModuleSourceDir = garden.projectRoot
      localModulePathA = join(localModuleSourceDir, "module-a")
      localModulePathB = join(localModuleSourceDir, "module-b")

      // Link some modules
      const linkCmd = new LinkModuleCommand()
      await linkCmd.action({
        garden,
        log: garden.log,
        headerLog: garden.log,
        footerLog: garden.log,
        args: {
          module: "module-a",
          path: localModulePathA,
        },
        opts: withDefaultGlobalOpts({}),
      })
      await linkCmd.action({
        garden,
        log: garden.log,
        headerLog: garden.log,
        footerLog: garden.log,
        args: {
          module: "module-b",
          path: localModulePathB,
        },
        opts: withDefaultGlobalOpts({}),
      })

      // We need to make a new instance of Garden after linking the sources
      // This is not an issue in practice because there are specific commands just for linking
      // so the user will always have a new instance of Garden when they run their next command.
      garden = await makeExtModuleSourcesGarden({ noCache: true })
      const graph = await garden.getConfigGraph({ log: garden.log, emit: false, noCache: true })

      await garden.startWatcher({ graph })
      await waitUntilReady(garden)
    })

    after(async () => {
      await resetLocalConfig(garden.gardenDirPath)
    })

    it("should watch all linked repositories", () => {
      const watcher = garden["watcher"]["watcher"]
      const shouldWatch = [garden.projectRoot, localModulePathA, localModulePathB]
      const watched = Object.keys(watcher!.getWatched())
      expect(
        shouldWatch.every((path) => watched.includes(path)),
        "Watched: " + watched.join(", ")
      ).to.be.true
    })

    it("should emit a moduleSourcesChanged event when a linked module source is changed", async () => {
      const pathsChanged = [resolve(localModulePathA, "foo.txt")]
      emitEvent(garden, "change", pathsChanged[0])
      await sleep(1000)
      await waitForProcessing()
      expect(getEventLog()).to.eql([
        {
          name: "moduleSourcesChanged",
          payload: { names: ["module-a"], pathsChanged },
        },
      ])
    })
  })

  context("linked project sources", () => {
    let localProjectSourceDir: string
    let localSourcePathA: string
    let localSourcePathB: string

    before(async () => {
      await garden.close()

      garden = await makeExtProjectSourcesGarden({ noCache: true })

      localProjectSourceDir = resolve(dataDir, "test-project-local-project-sources")
      localSourcePathA = join(localProjectSourceDir, "source-a")
      localSourcePathB = join(localProjectSourceDir, "source-b")

      // Link some projects
      const linkCmd = new LinkSourceCommand()
      await linkCmd.action({
        garden,
        log: garden.log,
        headerLog: garden.log,
        footerLog: garden.log,
        args: {
          source: "source-a",
          path: localSourcePathA,
        },
        opts: withDefaultGlobalOpts({}),
      })
      await linkCmd.action({
        garden,
        log: garden.log,
        headerLog: garden.log,
        footerLog: garden.log,
        args: {
          source: "source-b",
          path: localSourcePathB,
        },
        opts: withDefaultGlobalOpts({}),
      })

      // We need to make a new instance of Garden after linking the sources
      // This is not an issue in practice because there are specific commands just for linking
      // so the user will always have a new instance of Garden when they run their next command.
      garden = await makeExtProjectSourcesGarden({ noCache: true })
      const graph = await garden.getConfigGraph({ log: garden.log, emit: false, noCache: true })

      await garden.startWatcher({ graph })
      await waitUntilReady(garden)
    })

    after(async () => {
      await resetLocalConfig(garden.gardenDirPath)
    })

    it("should watch all linked repositories", () => {
      const watcher = garden["watcher"]["watcher"]
      const shouldWatch = [garden.projectRoot, localSourcePathA, localSourcePathB]
      const watched = Object.keys(watcher!.getWatched())
      expect(
        shouldWatch.every((path) => watched.includes(path)),
        "Watched: " + watched.join(", ")
      ).to.be.true
    })

    it("should emit a moduleSourcesChanged event when a linked project source is changed", async () => {
      const pathsChanged = [resolve(localProjectSourceDir, "source-a", "module-a", "foo.txt")]
      emitEvent(garden, "change", pathsChanged[0])
      expect(getEventLog()).to.eql([
        {
          name: "moduleSourcesChanged",
          payload: { names: ["module-a"], pathsChanged },
        },
      ])
    })
  })
})
