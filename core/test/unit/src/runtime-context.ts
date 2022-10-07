/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Garden } from "../../../src/garden"
import { makeTestGardenA } from "../../helpers"
import { ConfigGraph } from "../../../src/config-graph"
import { prepareRuntimeContext } from "../../../src/runtime-context"
import { expect } from "chai"

describe("prepareRuntimeContext", () => {
  let garden: Garden
  let graph: ConfigGraph

  before(async () => {
    garden = await makeTestGardenA()
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
  })

  it("should add the module version to the output envVars", async () => {
    const module = graph.getModule("module-a")

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      version: module.version.versionString,
      moduleVersion: module.version.versionString,
      dependencies: {
        build: [],
        deploy: [],
        run: [],
        test: [],
      },
      serviceStatuses: {},
      taskResults: {},
    })

    expect(runtimeContext.envVars.GARDEN_VERSION).to.equal(module.version.versionString)
    expect(runtimeContext.envVars.GARDEN_MODULE_VERSION).to.equal(module.version.versionString)
  })

  it("should add outputs for every build dependency output", async () => {
    const module = graph.getModule("module-a")
    const moduleB = graph.getModule("module-b")

    moduleB.outputs = { "my-output": "meep" }

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      version: module.version.versionString,
      moduleVersion: module.version.versionString,
      dependencies: {
        build: [moduleB],
        deploy: [],
        run: [],
        test: [],
      },
      serviceStatuses: {},
      taskResults: {},
    })

    expect(runtimeContext.dependencies).to.eql([
      {
        moduleName: "module-b",
        name: "module-b",
        outputs: moduleB.outputs,
        type: "build",
        version: moduleB.version.versionString,
      },
    ])
  })

  it("should add outputs for every service dependency runtime output", async () => {
    const module = graph.getModule("module-a")
    const serviceB = graph.getService("service-b")

    const outputs = {
      "my-output": "moop",
    }

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      version: module.version.versionString,
      moduleVersion: module.version.versionString,
      dependencies: {
        build: [],
        deploy: [serviceB],
        run: [],
        test: [],
      },
      serviceStatuses: {
        "service-b": {
          state: "ready",
          outputs,
          detail: {},
        },
      },
      taskResults: {},
    })

    expect(runtimeContext.dependencies).to.eql([
      {
        moduleName: "module-b",
        name: "service-b",
        outputs,
        type: "service",
        version: serviceB.version,
      },
    ])
  })

  it("should add outputs for every task dependency runtime output", async () => {
    const module = graph.getModule("module-a")
    const taskB = graph.getTask("task-b")

    const outputs = {
      "my-output": "mewp",
    }

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      version: module.version.versionString,
      moduleVersion: module.version.versionString,
      dependencies: {
        build: [],
        deploy: [],
        run: [taskB],
        test: [],
      },
      serviceStatuses: {},
      taskResults: {
        "task-b": {
          command: ["foo"],
          completedAt: new Date(),
          log: "mewp",
          moduleName: "module-b",
          outputs,
          startedAt: new Date(),
          success: true,
          taskName: "task-b",
          version: taskB.version,
        },
      },
    })

    expect(runtimeContext.dependencies).to.eql([
      {
        moduleName: "module-b",
        name: "task-b",
        outputs,
        type: "task",
        version: taskB.version,
      },
    ])
  })
})
