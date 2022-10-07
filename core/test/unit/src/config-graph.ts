/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve, join } from "path"
import { expect } from "chai"
import { ensureDir } from "fs-extra"
import stripAnsi from "strip-ansi"
import { makeTestGardenA, makeTestGarden, dataDir, expectError, makeTestModule } from "../../helpers"
import { getNames } from "../../../src/util/util"
import { ConfigGraph, DependencyGraphNode } from "../../../src/config-graph"
import { Garden } from "../../../src/garden"
import { DEFAULT_API_VERSION, GARDEN_CORE_ROOT } from "../../../src/constants"

describe("ConfigGraph", () => {
  let gardenA: Garden
  let graphA: ConfigGraph
  let tmpPath: string

  before(async () => {
    gardenA = await makeTestGardenA()
    graphA = await gardenA.getConfigGraph({ log: gardenA.log, emit: false })
    tmpPath = join(GARDEN_CORE_ROOT, "tmp")
    await ensureDir(tmpPath)
  })

  it("should throw when two services have the same name", async () => {
    const garden = await makeTestGarden(resolve(dataDir, "test-projects", "duplicate-service"))

    await expectError(
      () => garden.getConfigGraph({ log: garden.log, emit: false }),
      (err) =>
        expect(err.message).to.equal(
          "Service names must be unique - the service name 'dupe' is declared multiple times " +
            "(in modules 'module-a' and 'module-b')"
        )
    )
  })

  it("should throw when two tasks have the same name", async () => {
    const garden = await makeTestGarden(resolve(dataDir, "test-projects", "duplicate-task"))

    await expectError(
      () => garden.getConfigGraph({ log: garden.log, emit: false }),
      (err) =>
        expect(err.message).to.equal(
          "Task names must be unique - the task name 'dupe' is declared multiple times " +
            "(in modules 'module-a' and 'module-b')"
        )
    )
  })

  it("should throw when a service and a task have the same name", async () => {
    const garden = await makeTestGarden(resolve(dataDir, "test-projects", "duplicate-service-and-task"))

    await expectError(
      () => garden.getConfigGraph({ log: garden.log, emit: false }),
      (err) =>
        expect(err.message).to.equal(
          "Service and task names must be mutually unique - the name 'dupe' is used for a task " +
            "in 'module-b' and for a service in 'module-a'"
        )
    )
  })

  it("should automatically add service source modules as module build dependencies", async () => {
    const garden = await makeTestGarden(resolve(dataDir, "test-projects", "source-module"))
    const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    const module = graph.getModule("module-b")
    expect(module.build.dependencies).to.eql([{ name: "module-a", copy: [] }])
  })

  describe("getModules", () => {
    it("should scan and return all registered modules in the context", async () => {
      const modules = graphA.getModules()
      expect(getNames(modules).sort()).to.eql(["module-a", "module-b", "module-c"])
    })

    it("should optionally return specified modules in the context", async () => {
      const modules = graphA.getModules({ names: ["module-b", "module-c"] })
      expect(getNames(modules).sort()).to.eql(["module-b", "module-c"])
    })

    it("should omit disabled modules", async () => {
      const garden = await makeTestGardenA()

      await garden.scanAndAddConfigs()
      garden["moduleConfigs"]["module-c"].disabled = true

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const modules = graph.getModules()

      expect(modules.map((m) => m.name).sort()).to.eql(["module-a", "module-b"])
    })

    it("should optionally include disabled modules", async () => {
      const garden = await makeTestGardenA()

      await garden.scanAndAddConfigs()
      garden["moduleConfigs"]["module-c"].disabled = true

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const modules = graph.getModules({ includeDisabled: true })

      expect(modules.map((m) => m.name).sort()).to.eql(["module-a", "module-b", "module-c"])
    })

    it("should throw if specifically requesting a disabled module", async () => {
      const garden = await makeTestGardenA()

      await garden.scanAndAddConfigs()
      garden["moduleConfigs"]["module-c"].disabled = true

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      await expectError(
        () => graph.getModules({ names: ["module-c"] }),
        (err) => expect(err.message).to.equal("Could not find module(s): module-c")
      )
    })

    it("should throw if named module is missing", async () => {
      try {
        graphA.getModules({ names: ["bla"] })
      } catch (err) {
        expect(err.type).to.equal("parameter")
        return
      }

      throw new Error("Expected error")
    })

    it("should throw if a build dependency is missing", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        makeTestModule({
          name: "test",
          path: tmpPath,
          build: {
            dependencies: [{ name: "missing-build-dep", copy: [] }],
          },
        }),
      ])

      await expectError(
        () => garden.getConfigGraph({ log: garden.log, emit: false }),
        (err) =>
          expect(stripAnsi(err.message)).to.match(
            /Could not find build dependency missing-build-dep, configured in module test/
          )
      )
    })

    it("should throw if a runtime dependency is missing", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        makeTestModule({
          name: "test",
          path: tmpPath,
          spec: {
            services: [
              {
                name: "test-service",
                dependencies: ["missing-runtime-dep"],
                disabled: false,
                hotReloadable: false,
                spec: {},
              },
            ],
          },
        }),
      ])

      await expectError(
        () => garden.getConfigGraph({ log: garden.log, emit: false }),
        (err) =>
          expect(stripAnsi(err.message)).to.match(
            /Unknown service or task 'missing-runtime-dep' referenced in dependencies/
          )
      )
    })
  })

  describe("getServices", () => {
    it("should scan for modules and return all registered services in the context", async () => {
      const services = graphA.getServices()

      expect(getNames(services).sort()).to.eql(["service-a", "service-b", "service-c"])
    })

    it("should optionally return specified services in the context", async () => {
      const services = graphA.getServices({ names: ["service-b", "service-c"] })

      expect(getNames(services).sort()).to.eql(["service-b", "service-c"])
    })

    it("should omit disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
                hotReloadable: false,
                spec: {},
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.getServices()

      expect(deps).to.eql([])
    })

    it("should optionally include disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
                hotReloadable: false,
                spec: {},
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.getServices({ includeDisabled: true })

      expect(deps.map((s) => s.name)).to.eql(["disabled-service"])
    })

    it("should throw if specifically requesting a disabled service", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "service-a",
                dependencies: [],
                disabled: true,
                hotReloadable: false,
                spec: {},
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      await expectError(
        () => graph.getServices({ names: ["service-a"] }),
        (err) => expect(err.message).to.equal("Could not find service(s): service-a")
      )
    })

    it("should throw if named service is missing", async () => {
      try {
        graphA.getServices({ names: ["bla"] })
      } catch (err) {
        expect(err.type).to.equal("parameter")
        return
      }

      throw new Error("Expected error")
    })
  })

  describe("getService", () => {
    it("should return the specified service", async () => {
      const service = graphA.getService("service-b")

      expect(service.name).to.equal("service-b")
    })

    it("should throw if service is missing", async () => {
      try {
        graphA.getService("bla")
      } catch (err) {
        expect(err.type).to.equal("parameter")
        return
      }

      throw new Error("Expected error")
    })
  })

  describe("getTasks", () => {
    it("should scan for modules and return all registered tasks in the context", async () => {
      const tasks = graphA.getTasks()
      expect(getNames(tasks).sort()).to.eql(["task-a", "task-a2", "task-b", "task-c"])
    })

    it("should optionally return specified tasks in the context", async () => {
      const tasks = graphA.getTasks({ names: ["task-b", "task-c"] })
      expect(getNames(tasks).sort()).to.eql(["task-b", "task-c"])
    })

    it("should omit disabled tasks", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            tasks: [
              {
                name: "disabled-task",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.getTasks()

      expect(deps).to.eql([])
    })

    it("should optionally include disabled tasks", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            tasks: [
              {
                name: "disabled-task",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.getTasks({ includeDisabled: true })

      expect(deps.map((t) => t.name)).to.eql(["disabled-task"])
    })

    it("should throw if specifically requesting a disabled task", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            tasks: [
              {
                name: "disabled-task",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      await expectError(
        () => graph.getTasks({ names: ["disabled-task"] }),
        (err) => expect(err.message).to.equal("Could not find task(s): disabled-task")
      )
    })

    it("should throw if named task is missing", async () => {
      try {
        graphA.getTasks({ names: ["bla"] })
      } catch (err) {
        expect(err.type).to.equal("parameter")
        return
      }

      throw new Error("Expected error")
    })
  })

  describe("getTask", () => {
    it("should return the specified task", async () => {
      const task = graphA.getTask("task-b")

      expect(task.name).to.equal("task-b")
    })

    it("should throw if task is missing", async () => {
      try {
        graphA.getTask("bla")
      } catch (err) {
        expect(err.type).to.equal("parameter")
        return
      }

      throw new Error("Expected error")
    })
  })

  describe("getDependencies", () => {
    it("should include disabled modules in build dependencies", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: true,
          name: "module-a",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {},
          testConfigs: [],
          type: "test",
        },
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [{ name: "module-a", copy: [] }] },
          disabled: false,
          name: "module-b",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {},
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "build",
        name: "module-b",
        recursive: false,
      })

      expect(deps.build.map((m) => m.name)).to.eql(["module-a"])
    })

    it("should ignore dependencies by services on disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
              },
              {
                name: "enabled-service",
                dependencies: ["disabled-service"],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "deploy",
        name: "enabled-service",
        recursive: false,
      })

      expect(deps.deploy).to.eql([])
    })

    it("should ignore dependencies by services on disabled tasks", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "enabled-service",
                dependencies: ["disabled-task"],
                disabled: false,
              },
            ],
            tasks: [
              {
                name: "disabled-task",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "deploy",
        name: "enabled-service",
        recursive: false,
      })

      expect(deps.run).to.eql([])
    })

    it("should ignore dependencies by services on services in disabled modules", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-a",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-b",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "enabled-service",
                dependencies: ["disabled-service"],
                disabled: false,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "deploy",
        name: "enabled-service",
        recursive: false,
      })

      expect(deps.deploy).to.eql([])
    })

    it("should ignore dependencies by tasks on disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
              },
            ],
            tasks: [
              {
                name: "enabled-task",
                dependencies: ["disabled-service"],
                disabled: false,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "deploy",
        name: "enabled-task",
        recursive: false,
      })

      expect(deps.deploy).to.eql([])
    })

    it("should ignore dependencies by tests on disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "foo",
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "disabled-service",
                dependencies: [],
                disabled: true,
              },
            ],
            tests: [
              {
                name: "enabled-test",
                dependencies: ["disabled-service"],
                disabled: false,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })

      const deps = graph.getDependencies({
        nodeType: "deploy",
        name: "enabled-test",
        recursive: false,
      })

      expect(deps.deploy).to.eql([])
    })
  })

  describe("resolveDependencyModules", () => {
    it("should include disabled modules in build dependencies", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: true,
          name: "module-a",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {},
          testConfigs: [],
          type: "test",
        },
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-b",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {},
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.resolveDependencyModules([{ name: "module-a", copy: [] }], [])

      expect(deps.map((m) => m.name)).to.eql(["module-a"])
    })
  })

  describe("getDependants", () => {
    it("should not traverse past disabled services", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-a",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "service-a",
                dependencies: [],
                disabled: true,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-b",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "service-b",
                dependencies: ["service-a"],
                disabled: false,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const deps = graph.getDependants({ nodeType: "build", name: "module-a", recursive: true })

      expect(deps.deploy.map((m) => m.name)).to.eql([])
    })
  })

  describe("getDependantsForModule", () => {
    it("should return services and tasks for a build dependant of the given module", async () => {
      const garden = await makeTestGardenA()

      garden.setModuleConfigs([
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          name: "module-a",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {},
          testConfigs: [],
          type: "test",
        },
        {
          apiVersion: DEFAULT_API_VERSION,
          allowPublish: false,
          build: { dependencies: [{ name: "module-a", copy: [] }] },
          disabled: false,
          name: "module-b",
          include: [],
          path: tmpPath,
          serviceConfigs: [],
          taskConfigs: [],
          spec: {
            services: [
              {
                name: "service-b",
                dependencies: [],
                disabled: false,
              },
            ],
            tasks: [
              {
                name: "task-b",
                dependencies: [],
                disabled: false,
              },
            ],
          },
          testConfigs: [],
          type: "test",
        },
      ])

      const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
      const moduleA = graph.getModule("module-a")
      const deps = graph.getDependantsForModule(moduleA, true)

      expect(deps.deploy.map((m) => m.name)).to.eql(["service-b"])
      expect(deps.run.map((m) => m.name)).to.eql(["task-b"])
    })
  })

  describe("resolveDependencyModules", () => {
    it("should resolve build dependencies", async () => {
      const modules = graphA.resolveDependencyModules([{ name: "module-c", copy: [] }], [])
      expect(getNames(modules)).to.eql(["module-a", "module-b", "module-c"])
    })

    it("should resolve service dependencies", async () => {
      const modules = graphA.resolveDependencyModules([], ["service-b"])
      expect(getNames(modules)).to.eql(["module-a", "module-b"])
    })

    it("should combine module and service dependencies", async () => {
      const modules = graphA.resolveDependencyModules([{ name: "module-b", copy: [] }], ["service-c"])
      expect(getNames(modules)).to.eql(["module-a", "module-b", "module-c"])
    })
  })

  describe("render", () => {
    it("should render config graph nodes with test names", () => {
      const rendered = graphA.render()
      expect(rendered.nodes).to.include.deep.members([
        {
          type: "build",
          name: "module-a",
          moduleName: "module-a",
          key: "build.module-a",
          disabled: false,
        },
        {
          type: "build",
          name: "module-b",
          moduleName: "module-b",
          key: "build.module-b",
          disabled: false,
        },
        {
          type: "build",
          name: "module-c",
          moduleName: "module-c",
          key: "build.module-c",
          disabled: false,
        },
        {
          type: "test",
          name: "unit",
          moduleName: "module-c",
          key: "test.module-c.unit",
          disabled: false,
        },
        {
          type: "test",
          name: "integ",
          moduleName: "module-c",
          key: "test.module-c.integ",
          disabled: false,
        },
        {
          type: "run",
          name: "task-c",
          moduleName: "module-c",
          key: "task.task-c",
          disabled: false,
        },
        {
          type: "deploy",
          name: "service-c",
          moduleName: "module-c",
          key: "deploy.service-c",
          disabled: false,
        },
        {
          type: "test",
          name: "unit",
          moduleName: "module-a",
          key: "test.module-a.unit",
          disabled: false,
        },
        {
          type: "test",
          name: "integration",
          moduleName: "module-a",
          key: "test.module-a.integration",
          disabled: false,
        },
        {
          type: "run",
          name: "task-a",
          moduleName: "module-a",
          key: "task.task-a",
          disabled: false,
        },
        {
          type: "test",
          name: "unit",
          moduleName: "module-b",
          key: "test.module-b.unit",
          disabled: false,
        },
        {
          type: "run",
          name: "task-b",
          moduleName: "module-b",
          key: "task.task-b",
          disabled: false,
        },
        {
          type: "deploy",
          name: "service-a",
          moduleName: "module-a",
          key: "deploy.service-a",
          disabled: false,
        },
        {
          type: "deploy",
          name: "service-b",
          moduleName: "module-b",
          key: "deploy.service-b",
          disabled: false,
        },
      ])
    })
  })
})

describe("DependencyGraphNode", () => {
  describe("render", () => {
    it("should render a build node", () => {
      const node = new DependencyGraphNode("build", "module-a", "module-a", false)
      const res = node.render()
      expect(res).to.eql({
        type: "build",
        name: "module-a",
        moduleName: "module-a",
        key: "build.module-a",
        disabled: false,
      })
    })

    it("should render a deploy node", () => {
      const node = new DependencyGraphNode("deploy", "service-a", "module-a", false)
      const res = node.render()
      expect(res).to.eql({
        type: "deploy",
        name: "service-a",
        moduleName: "module-a",
        key: "deploy.service-a",
        disabled: false,
      })
    })

    it("should render a run node", () => {
      const node = new DependencyGraphNode("run", "task-a", "module-a", false)
      const res = node.render()
      expect(res).to.eql({
        type: "run",
        name: "task-a",
        moduleName: "module-a",
        key: "task.task-a",
        disabled: false,
      })
    })

    it("should render a test node", () => {
      const node = new DependencyGraphNode("test", "module-a.test-a", "module-a", false)
      const res = node.render()
      expect(res).to.eql({
        type: "test",
        name: "test-a",
        moduleName: "module-a",
        key: "test.module-a.test-a",
        disabled: false,
      })
    })

    it("should indicate if the node is disabled", () => {
      const node = new DependencyGraphNode("test", "module-a.test-a", "module-a", true)
      const res = node.render()
      expect(res).to.eql({
        type: "test",
        name: "test-a",
        moduleName: "module-a",
        key: "test.module-a.test-a",
        disabled: true,
      })
    })
  })
})
