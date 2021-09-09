/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { join, resolve } from "path"
import { Garden } from "../../../../src/garden"
import { gardenPlugin, configureExecModule } from "../../../../src/plugins/exec"
import { GARDEN_BUILD_VERSION_FILENAME, DEFAULT_API_VERSION } from "../../../../src/constants"
import { LogEntry } from "../../../../src/logger/log-entry"
import { keyBy } from "lodash"
import { getDataDir, makeTestModule, expectError, TestGarden } from "../../../helpers"
import { TaskTask } from "../../../../src/tasks/task"
import { readModuleVersionFile } from "../../../../src/vcs/vcs"
import { dataDir, makeTestGarden } from "../../../helpers"
import { ModuleConfig } from "../../../../src/config/module"
import { ConfigGraph } from "../../../../src/config-graph"
import { pathExists, emptyDir } from "fs-extra"
import { TestTask } from "../../../../src/tasks/test"
import { defaultNamespace } from "../../../../src/config/project"
import { readFile, remove } from "fs-extra"
import { testFromConfig } from "../../../../src/types/test"
import { dedent } from "../../../../src/util/string"

describe("exec plugin", () => {
  const projectRoot = resolve(dataDir, "test-project-exec")
  const moduleName = "module-a"

  let garden: Garden
  let graph: ConfigGraph
  let log: LogEntry

  beforeEach(async () => {
    garden = await makeTestGarden(projectRoot, { plugins: [gardenPlugin] })
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    log = garden.log
    await garden.clearBuilds()
  })

  it("should run a script on init in the project root, if configured", async () => {
    const _garden = await TestGarden.factory(garden.projectRoot, {
      plugins: [],
      config: {
        apiVersion: DEFAULT_API_VERSION,
        kind: "Project",
        name: "test",
        path: garden.projectRoot,
        defaultEnvironment: "default",
        dotIgnoreFiles: [],
        environments: [{ name: "default", defaultNamespace, variables: {} }],
        providers: [{ name: "exec", initScript: "echo hello! > .garden/test.txt" }],
        variables: {},
      },
    })

    await _garden.resolveProviders(_garden.log)

    const f = await readFile(join(garden.projectRoot, ".garden", "test.txt"))

    expect(f.toString().trim()).to.equal("hello!")
  })

  it("should throw if a script configured and exits with a non-zero code", async () => {
    const _garden = await TestGarden.factory(garden.projectRoot, {
      plugins: [],
      config: {
        apiVersion: DEFAULT_API_VERSION,
        kind: "Project",
        name: "test",
        path: garden.projectRoot,
        defaultEnvironment: "default",
        dotIgnoreFiles: [],
        environments: [{ name: "default", defaultNamespace, variables: {} }],
        providers: [{ name: "exec", initScript: "echo oh no!; exit 1" }],
        variables: {},
      },
    })

    await expectError(() => _garden.resolveProviders(_garden.log), "plugin")
  })

  it("should correctly parse exec modules", async () => {
    const modules = keyBy(graph.getModules(), "name")
    const { "module-a": moduleA, "module-b": moduleB, "module-c": moduleC, "module-local": moduleLocal } = modules

    expect(moduleA.build).to.eql({
      dependencies: [],
    })
    expect(moduleA.spec.build).to.eql({
      command: ["echo", "A"],
      dependencies: [],
    })
    expect(moduleA.serviceConfigs).to.eql([
      {
        dependencies: [],
        disabled: false,
        hotReloadable: false,
        name: "apple",
        spec: {
          cleanupCommand: ["rm -f deployed.log && echo cleaned up"],
          dependencies: [],
          deployCommand: ["touch deployed.log && echo deployed"],
          disabled: false,
          env: {},
          name: "apple",
          statusCommand: ["test -f deployed.log && echo already deployed"],
        },
      },
    ])
    expect(moduleA.taskConfigs).to.eql([
      {
        name: "banana",
        cacheResult: false,
        dependencies: ["orange"],
        disabled: false,
        timeout: null,
        spec: {
          artifacts: [],
          name: "banana",
          command: ["echo", "BANANA"],
          env: {},
          dependencies: ["orange"],
          disabled: false,
          timeout: null,
        },
      },
      {
        name: "orange",
        cacheResult: false,
        dependencies: [],
        disabled: false,
        timeout: 999,
        spec: {
          artifacts: [],
          name: "orange",
          command: ["echo", "ORANGE"],
          env: {},
          dependencies: [],
          disabled: false,
          timeout: 999,
        },
      },
    ])
    expect(moduleA.testConfigs).to.eql([
      {
        name: "unit",
        dependencies: [],
        disabled: false,
        timeout: null,
        spec: {
          name: "unit",
          artifacts: [],
          dependencies: [],
          disabled: false,
          command: ["echo", "OK"],
          env: {
            FOO: "boo",
          },
          timeout: null,
        },
      },
    ])

    expect(moduleB.build).to.eql({
      dependencies: [{ name: "module-a", copy: [] }],
    })
    expect(moduleB.spec.build).to.eql({
      command: ["echo", "B"],
      dependencies: [{ name: "module-a", copy: [] }],
    })
    expect(moduleB.serviceConfigs).to.eql([])
    expect(moduleB.taskConfigs).to.eql([])
    expect(moduleB.testConfigs).to.eql([
      {
        name: "unit",
        dependencies: [],
        disabled: false,
        timeout: null,
        spec: {
          name: "unit",
          artifacts: [],
          dependencies: [],
          disabled: false,
          command: ["echo", "OK"],
          env: {},
          timeout: null,
        },
      },
    ])

    expect(moduleC.build).to.eql({
      dependencies: [{ name: "module-b", copy: [] }],
    })
    expect(moduleC.spec.build).to.eql({
      command: [],
      dependencies: [{ name: "module-b", copy: [] }],
    })
    expect(moduleC.serviceConfigs).to.eql([])
    expect(moduleC.taskConfigs).to.eql([])
    expect(moduleC.testConfigs).to.eql([
      {
        name: "unit",
        dependencies: [],
        disabled: false,
        timeout: null,
        spec: {
          name: "unit",
          dependencies: [],
          artifacts: [],
          disabled: false,
          command: ["echo", "OK"],
          env: {},
          timeout: null,
        },
      },
    ])

    expect(moduleLocal.spec.local).to.eql(true)
    expect(moduleLocal.build).to.eql({
      dependencies: [],
    })
    expect(moduleLocal.spec.build).to.eql({
      command: ["pwd"],
      dependencies: [],
    })
    expect(moduleLocal.serviceConfigs).to.eql([
      {
        dependencies: [],
        disabled: false,
        hotReloadable: false,
        name: "touch",
        spec: {
          cleanupCommand: ["rm -f deployed.log && echo cleaned up"],
          dependencies: [],
          deployCommand: ["touch deployed.log && echo deployed"],
          disabled: false,
          env: {},
          name: "touch",
          statusCommand: ["test -f deployed.log && echo already deployed"],
        },
      },
      {
        dependencies: [],
        disabled: false,
        hotReloadable: false,
        name: "echo",
        spec: {
          dependencies: [],
          deployCommand: ["echo", "deployed $NAME"],
          disabled: false,
          env: { NAME: "echo service" },
          name: "echo",
        },
      },
      {
        dependencies: [],
        disabled: false,
        hotReloadable: false,
        name: "error",
        spec: {
          cleanupCommand: ["sh", '-c "echo fail! && exit 1"'],
          dependencies: [],
          deployCommand: ["sh", '-c "echo fail! && exit 1"'],
          disabled: false,
          env: {},
          name: "error",
        },
      },
    ])
    expect(moduleLocal.taskConfigs).to.eql([
      {
        name: "pwd",
        cacheResult: false,
        dependencies: [],
        disabled: false,
        timeout: null,
        spec: {
          name: "pwd",
          env: {},
          command: ["pwd"],
          artifacts: [],
          dependencies: [],
          disabled: false,
          timeout: null,
        },
      },
    ])
    expect(moduleLocal.testConfigs).to.eql([])
  })

  it("should propagate task logs to runtime outputs", async () => {
    const _garden = await makeTestGarden(getDataDir("test-projects", "exec-task-outputs"))
    const _graph = await _garden.getConfigGraph({ log: _garden.log, emit: false })
    const taskB = _graph.getTask("task-b")

    const taskTask = new TaskTask({
      garden: _garden,
      graph: _graph,
      task: taskB,
      log: _garden.log,
      force: false,
      forceBuild: false,
      devModeServiceNames: [],
      hotReloadServiceNames: [],
    })
    const results = await _garden.processTasks([taskTask])

    // Task A echoes "task-a-output" and Task B echoes the output from Task A
    expect(results["task.task-b"]).to.exist
    expect(results["task.task-b"]).to.have.property("output")
    expect(results["task.task-b"]!.output.log).to.equal("task-a-output")
    expect(results["task.task-b"]!.output).to.have.property("outputs")
    expect(results["task.task-b"]!.output.outputs.log).to.equal("task-a-output")
  })

  it("should copy artifacts after task runs", async () => {
    const _garden = await makeTestGarden(getDataDir("test-projects", "exec-artifacts"))
    const _graph = await _garden.getConfigGraph({ log: _garden.log, emit: false })
    const task = _graph.getTask("task-a")

    const taskTask = new TaskTask({
      garden: _garden,
      graph: _graph,
      task,
      log: _garden.log,
      force: false,
      forceBuild: false,
      devModeServiceNames: [],
      hotReloadServiceNames: [],
    })

    await emptyDir(_garden.artifactsPath)

    await _garden.processTasks([taskTask])

    expect(await pathExists(join(_garden.artifactsPath, "task-outputs", "task-a.txt"))).to.be.true
  })

  it("should copy artifacts after test runs", async () => {
    const _garden = await makeTestGarden(getDataDir("test-projects", "exec-artifacts"))
    const _graph = await _garden.getConfigGraph({ log: _garden.log, emit: false })
    const test = _graph.getTest("module-a", "test-a")

    const testTask = new TestTask({
      garden: _garden,
      graph: _graph,
      test,
      log: _garden.log,
      force: false,
      forceBuild: false,
      devModeServiceNames: [],
      hotReloadServiceNames: [],
    })

    await emptyDir(_garden.artifactsPath)

    await _garden.processTasks([testTask])

    expect(await pathExists(join(_garden.artifactsPath, "test-outputs", "test-a.txt"))).to.be.true
  })

  describe("configureExecModule", () => {
    it("should throw if a local exec module has a build.copy spec", async () => {
      const moduleConfig = makeTestModule(<Partial<ModuleConfig>>{
        local: true,
        build: {
          dependencies: [
            {
              name: "foo",
              copy: [
                {
                  source: ".",
                  target: ".",
                },
              ],
            },
          ],
        },
      })
      const provider = await garden.resolveProvider(garden.log, "test-plugin")
      const ctx = await garden.getPluginContext(provider)
      await expectError(async () => await configureExecModule({ ctx, moduleConfig, log }), "configuration")
    })
  })

  describe("build", () => {
    it("should write a build version file after building", async () => {
      const module = graph.getModule(moduleName)
      const buildMetadataPath = module.buildMetadataPath
      const versionFilePath = join(buildMetadataPath, GARDEN_BUILD_VERSION_FILENAME)

      await garden.buildStaging.syncFromSrc(module, log)
      const actions = await garden.getActionRouter()
      await actions.build({ log, module, graph })

      const versionFileContents = await readModuleVersionFile(versionFilePath)

      expect(versionFileContents).to.eql(module.version)
    })

    it("should run the build command in the module dir if local true", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()
      const res = await actions.build({ log, module, graph })
      expect(res.buildLog).to.eql(join(projectRoot, "module-local"))
    })

    it("should receive module version as an env var", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()

      module.spec.build.command = ["echo", "$GARDEN_MODULE_VERSION"]
      const res = await actions.build({ log, module, graph })

      expect(res.buildLog).to.equal(module.version.versionString)
    })
  })

  describe("testExecModule", () => {
    it("should run the test command in the module dir if local true", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()
      const res = await actions.testModule({
        log,
        module,
        interactive: true,
        graph,
        runtimeContext: {
          envVars: {},
          dependencies: [],
        },
        silent: false,
        test: testFromConfig(
          module,
          {
            name: "test",
            dependencies: [],
            disabled: false,
            timeout: 1234,
            spec: {
              command: ["pwd"],
            },
          },
          graph
        ),
      })
      expect(res.log).to.eql(join(projectRoot, "module-local"))
    })

    it("should receive module version as an env var", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()
      const res = await actions.testModule({
        log,
        module,
        interactive: true,
        graph,
        runtimeContext: {
          envVars: {},
          dependencies: [],
        },
        silent: false,
        test: testFromConfig(
          module,
          {
            name: "test",
            dependencies: [],
            disabled: false,
            timeout: 1234,
            spec: {
              command: ["echo", "$GARDEN_MODULE_VERSION"],
            },
          },
          graph
        ),
      })
      expect(res.log).to.equal(module.version.versionString)
    })
  })

  describe("runExecTask", () => {
    it("should run the task command in the module dir if local true", async () => {
      const actions = await garden.getActionRouter()
      const task = graph.getTask("pwd")
      const res = await actions.runTask({
        log,
        task,
        interactive: true,
        graph,
        runtimeContext: {
          envVars: {},
          dependencies: [],
        },
      })
      expect(res.log).to.eql(join(projectRoot, "module-local"))
    })

    it("should receive module version as an env var", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()
      const task = graph.getTask("pwd")

      task.spec.command = ["echo", "$GARDEN_MODULE_VERSION"]

      const res = await actions.runTask({
        log,
        task,
        interactive: true,
        graph,
        runtimeContext: {
          envVars: {},
          dependencies: [],
        },
      })

      expect(res.log).to.equal(module.version.versionString)
    })
  })

  describe("runExecModule", () => {
    it("should run the module with the args that are passed through the command", async () => {
      const module = graph.getModule("module-local")
      const actions = await garden.getActionRouter()
      const res = await actions.runModule({
        log,
        module,
        command: [],
        args: ["echo", "hello", "world"],
        interactive: false,
        graph,
        runtimeContext: {
          envVars: {},
          dependencies: [],
        },
      })
      expect(res.log).to.eql("hello world")
    })
  })

  context("services", () => {
    const touchFilePath = join(projectRoot, "module-local", "deployed.log")

    beforeEach(async () => {
      await remove(touchFilePath)
    })

    describe("deployExecService", () => {
      it("runs the service's deploy command with the specified env vars", async () => {
        const service = graph.getService("echo")
        const actions = await garden.getActionRouter()
        const res = await actions.deployService({
          devMode: false,
          force: false,
          hotReload: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.detail.deployCommandOutput).to.eql("deployed echo service")
      })

      it("throws if deployCommand returns with non-zero code", async () => {
        const service = graph.getService("error")
        const actions = await garden.getActionRouter()
        await expectError(
          async () =>
            await actions.deployService({
              devMode: false,
              force: false,
              hotReload: false,
              log,
              service,
              graph,
              runtimeContext: {
                envVars: {},
                dependencies: [],
              },
            }),
          (err) =>
            expect(err.message).to.equal(dedent`
            Command "sh -c "echo fail! && exit 1"" failed with code 1:

            Here's the full output:

            fail!
            `)
        )
      })
    })

    describe("getExecServiceStatus", async () => {
      it("returns 'unknown' if no statusCommand is set", async () => {
        const service = graph.getService("error")
        const actions = await garden.getActionRouter()
        const res = await actions.getServiceStatus({
          devMode: false,
          hotReload: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.state).to.equal("unknown")
      })

      it("returns 'ready' if statusCommand returns zero exit code", async () => {
        const service = graph.getService("touch")
        const actions = await garden.getActionRouter()
        await actions.deployService({
          devMode: false,
          hotReload: false,
          force: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        const res = await actions.getServiceStatus({
          devMode: false,
          hotReload: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.state).to.equal("ready")
        expect(res.detail.statusCommandOutput).to.equal("already deployed")
      })

      it("returns 'outdated' if statusCommand returns non-zero exit code", async () => {
        const service = graph.getService("touch")
        const actions = await garden.getActionRouter()
        const res = await actions.getServiceStatus({
          devMode: false,
          hotReload: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.state).to.equal("outdated")
      })
    })

    describe("deleteExecService", async () => {
      it("runs the cleanup command if set", async () => {
        const service = graph.getService("touch")
        const actions = await garden.getActionRouter()
        await actions.deployService({
          devMode: false,
          hotReload: false,
          force: false,
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        const res = await actions.deleteService({
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.state).to.equal("missing")
        expect(res.detail.cleanupCommandOutput).to.equal("cleaned up")
      })

      it("returns 'unknown' state if no cleanupCommand is set", async () => {
        const service = graph.getService("echo")
        const actions = await garden.getActionRouter()
        const res = await actions.deleteService({
          log,
          service,
          graph,
          runtimeContext: {
            envVars: {},
            dependencies: [],
          },
        })
        expect(res.state).to.equal("unknown")
      })

      it("throws if cleanupCommand returns with non-zero code", async () => {
        const service = graph.getService("error")
        const actions = await garden.getActionRouter()
        await expectError(
          async () =>
            await actions.deleteService({
              log,
              service,
              graph,
              runtimeContext: {
                envVars: {},
                dependencies: [],
              },
            }),
          (err) =>
            expect(err.message).to.equal(dedent`
            Command "sh -c "echo fail! && exit 1"" failed with code 1:

            Here's the full output:

            fail!
            `)
        )
      })
    })
  })
})
