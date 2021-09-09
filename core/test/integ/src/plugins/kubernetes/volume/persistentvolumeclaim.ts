/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import tmp from "tmp-promise"
import { ProjectConfig, defaultNamespace } from "../../../../../../src/config/project"
import execa = require("execa")
import { DEFAULT_API_VERSION } from "../../../../../../src/constants"
import { expect } from "chai"
import { TestGarden, makeTempDir } from "../../../../../helpers"
import { DeployTask } from "../../../../../../src/tasks/deploy"
import { emptyRuntimeContext } from "../../../../../../src/runtime-context"
import { isSubset } from "../../../../../../src/util/is-subset"

describe("persistentvolumeclaim", () => {
  let tmpDir: tmp.DirectoryResult
  let projectConfigFoo: ProjectConfig

  before(async () => {
    tmpDir = await makeTempDir()

    await execa("git", ["init"], { cwd: tmpDir.path })

    projectConfigFoo = {
      apiVersion: DEFAULT_API_VERSION,
      kind: "Project",
      name: "test",
      path: tmpDir.path,
      defaultEnvironment: "default",
      dotIgnoreFiles: [],
      environments: [{ name: "default", defaultNamespace, variables: {} }],
      providers: [{ name: "local-kubernetes", namespace: "default" }],
      variables: {},
    }
  })

  after(async () => {
    await tmpDir.cleanup()
  })

  it("should successfully deploy a simple PVC", async () => {
    const garden = await TestGarden.factory(tmpDir.path, {
      plugins: [],
      config: projectConfigFoo,
    })

    const spec = {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: "1Gi",
        },
      },
    }

    garden.setModuleConfigs([
      {
        apiVersion: DEFAULT_API_VERSION,
        name: "test",
        type: "persistentvolumeclaim",
        allowPublish: false,
        build: { dependencies: [] },
        disabled: false,
        path: tmpDir.path,
        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
        spec: {
          spec,
        },
      },
    ])

    const graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    const service = graph.getService("test")

    const deployTask = new DeployTask({
      garden,
      graph,
      log: garden.log,
      service,
      force: true,
      forceBuild: false,
      devModeServiceNames: [],
      hotReloadServiceNames: [],
    })

    await garden.processTasks([deployTask], { throwOnError: true })

    const actions = await garden.getActionRouter()
    const status = await actions.getServiceStatus({
      log: garden.log,
      service,
      devMode: false,
      hotReload: false,
      graph,
      runtimeContext: emptyRuntimeContext,
    })

    const remoteResources = status.detail["remoteResources"]

    expect(status.state === "ready")
    expect(remoteResources.length).to.equal(1)
    expect(
      isSubset(remoteResources[0], {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: "test", namespace: "default" },
        spec,
      })
    ).to.be.true

    await actions.deleteService({ log: garden.log, service, graph })
  })
})
