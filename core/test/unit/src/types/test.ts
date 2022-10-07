/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { resolve } from "path"
import { dataDir, makeTestGarden, makeTestGardenA } from "../../../helpers"
import { TestConfig } from "../../../../src/config/test"
import { testFromConfig } from "../../../../src/types/test"
import { cloneDeep } from "lodash"

describe("testFromConfig", () => {
  it("should propagate the disabled flag from the config", async () => {
    const config: TestConfig = {
      name: "test",
      dependencies: [],
      disabled: true,
      spec: {},
      timeout: null,
    }

    const garden = await makeTestGardenA()
    const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    const module = graph.getModule("module-a")
    const test = testFromConfig(module, config, graph)

    expect(test.disabled).to.be.true
  })

  it("should set disabled=true if the module is disabled", async () => {
    const config: TestConfig = {
      name: "test",
      dependencies: [],
      disabled: false,
      spec: {},
      timeout: null,
    }

    const garden = await makeTestGardenA()
    const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    const module = graph.getModule("module-a")
    module.disabled = true
    const test = testFromConfig(module, config, graph)

    expect(test.disabled).to.be.true
  })

  it("should include dependencies in version calculation", async () => {
    const garden = await makeTestGarden(resolve(dataDir, "test-project-test-deps"))
    let graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    let moduleA = graph.getModule("module-a")
    const testConfig = moduleA.testConfigs[0]
    const versionBeforeChange = testFromConfig(moduleA, testConfig, graph).version
    const backup = cloneDeep(graph["modules"]["module-b"])

    // Verify that changed build version is reflected in the test version
    graph["modules"]["module-b"].version.versionString = "12345"
    moduleA = graph.getModule("module-a")
    const testAfterBuildChange = testFromConfig(moduleA, testConfig, graph)
    expect(versionBeforeChange).to.not.eql(testAfterBuildChange.version)

    // Verify that changed service dependency config is reflected in the test version
    graph["modules"]["module-b"] = backup
    graph["serviceConfigs"]["service-b"].config.spec["command"] = ["echo", "something-else"]
    moduleA = graph.getModule("module-a")
    const testAfterServiceConfigChange = testFromConfig(moduleA, testConfig, graph)
    expect(versionBeforeChange).to.not.eql(testAfterServiceConfigChange.version)

    // Verify that changed task dependency config is reflected in the test version
    graph["modules"]["module-b"] = backup
    graph["taskConfigs"]["task-a"].config.spec["command"] = ["echo", "something-else"]
    moduleA = graph.getModule("module-a")
    const testAfterTaskConfigChange = testFromConfig(moduleA, testConfig, graph)
    expect(versionBeforeChange).to.not.eql(testAfterTaskConfigChange.version)
  })
})
