/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { ConfigGraph } from "../../../../src/config-graph"
import { LogEntry } from "../../../../src/logger/log-entry"
import { CloudEventHandlerCommonParams, cloudEventHandlers } from "../../../../src/process"
import { makeTestGardenA, TestGarden } from "../../../helpers"

describe("cloudEventHandlers", () => {
  let garden: TestGarden
  let graph: ConfigGraph
  let log: LogEntry
  let params: CloudEventHandlerCommonParams

  before(async () => {
    garden = await makeTestGardenA()
    log = garden.log
    graph = await garden.getConfigGraph({ log, emit: false })
    params = { garden, log, graph }
  })

  describe("buildRequested", () => {
    it("should return a build task for the requested module", async () => {
      const tasks = await cloudEventHandlers.buildRequested({
        ...params,
        request: { moduleName: "module-a", force: false },
      })
      expect(tasks.length).to.eql(1)
      const buildTask = tasks.find((t) => t.type === "build")
      expect(buildTask).to.exist
      expect(buildTask!["module"].name).to.eql("module-a")
      expect(buildTask!.force).to.eql(false)
    })

    it("should optionally return a build task with force = true for the requested module", async () => {
      const tasks = await cloudEventHandlers.buildRequested({
        ...params,
        request: { moduleName: "module-a", force: true },
      })
      expect(tasks.length).to.eql(1)
      const buildTask = tasks.find((t) => t.type === "build")
      expect(buildTask).to.exist
      expect(buildTask!["module"].name).to.eql("module-a")
      expect(buildTask!.force).to.eql(true)
    })
  })

  describe("deployRequested", () => {
    it("should return a deploy task for the requested service", async () => {
      const deployTask = await cloudEventHandlers.deployRequested({
        ...params,
        request: {
          serviceName: "service-a",
          force: false,
          forceBuild: false,
          devMode: false,
          hotReload: false,
          localMode: false,
          skipDependencies: true,
        },
      })
      expect(deployTask["devModeServiceNames"]).to.eql([])
      expect(deployTask["hotReloadServiceNames"]).to.eql([])
      expect(deployTask["localModeServiceNames"]).to.eql([])
      expect(deployTask.service.name).to.eql("service-a")
    })

    it("should return a dev-mode deploy task for the requested service", async () => {
      const deployTask = await cloudEventHandlers.deployRequested({
        ...params,
        request: {
          serviceName: "service-a",
          force: false,
          forceBuild: false,
          devMode: true,
          hotReload: false,
          localMode: false,
          skipDependencies: true,
        },
      })
      expect(deployTask["service"].name).to.eql("service-a")
      // todo
      // expect(deployTask["devModeServiceNames"]).to.eql(["service-a"])
    })

    it("should return a local-mode deploy task for the requested service", async () => {
      const deployTask = await cloudEventHandlers.deployRequested({
        ...params,
        request: {
          serviceName: "service-a",
          force: false,
          forceBuild: false,
          devMode: false,
          hotReload: false,
          localMode: true,
          skipDependencies: true,
        },
      })
      expect(deployTask["service"].name).to.eql("service-a")
      // todo
      // expect(deployTask["localModeServiceNames"]).to.eql(["service-a"])
    })
  })

  describe("testRequested", () => {
    it("should return test tasks for the requested module", async () => {
      const testTasks = await cloudEventHandlers.testRequested({
        ...params,
        request: { moduleName: "module-a", force: false, forceBuild: false, skipDependencies: true },
      })
      expect(testTasks.map((t) => t["test"].name).sort()).to.eql(["integration", "unit"])
    })

    it("should return test tasks for the requested module and test names", async () => {
      const testTasks = await cloudEventHandlers.testRequested({
        ...params,
        request: {
          moduleName: "module-a",
          force: false,
          forceBuild: false,
          testNames: ["unit"],
          skipDependencies: true,
        },
      })
      expect(testTasks.map((t) => t["test"].name).sort()).to.eql(["unit"])
    })
  })

  describe("taskRequested", () => {
    it("should return test tasks for the requested module", async () => {
      const taskTask = await cloudEventHandlers.taskRequested({
        ...params,
        request: { taskName: "task-a", force: false, forceBuild: false },
      })
      expect(taskTask["task"].name).to.eql("task-a")
    })
  })
})
