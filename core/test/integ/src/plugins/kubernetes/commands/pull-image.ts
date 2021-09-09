/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { pullModule } from "../../../../../../src/plugins/kubernetes/commands/pull-image"
import { Garden } from "../../../../../../src/garden"
import { ConfigGraph } from "../../../../../../src/config-graph"
import { getContainerTestGarden } from "../container/container"
import { k8sBuildContainer } from "../../../../../../src/plugins/kubernetes/container/build/build"
import { PluginContext } from "../../../../../../src/plugin-context"
import { KubernetesProvider, KubernetesPluginContext } from "../../../../../../src/plugins/kubernetes/config"
import { GardenModule } from "../../../../../../src/types/module"
import { containerHelpers } from "../../../../../../src/plugins/container/helpers"
import { expect } from "chai"
import { grouped } from "../../../../../helpers"

describe("pull-image plugin command", () => {
  let garden: Garden
  let graph: ConfigGraph
  let provider: KubernetesProvider
  let ctx: PluginContext

  after(async () => {
    if (garden) {
      await garden.close()
    }
  })

  const init = async (environmentName: string) => {
    garden = await getContainerTestGarden(environmentName)
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    provider = <KubernetesProvider>await garden.resolveProvider(garden.log, "local-kubernetes")
    ctx = await garden.getPluginContext(provider)
  }

  async function removeImage(module: GardenModule) {
    const imageId = containerHelpers.getLocalImageId(module, module.version)
    try {
      await containerHelpers.dockerCli({
        cwd: "/tmp",
        args: ["rmi", imageId],
        log: garden.log,
        ctx,
      })
    } catch {
      // This is fine, the image may not already be there
    }
  }

  async function ensureImagePulled(module: GardenModule) {
    const imageId = containerHelpers.getLocalImageId(module, module.version)
    const imageHash = await containerHelpers.dockerCli({
      cwd: module.buildPath,
      args: ["run", imageId, "echo", "ok"],
      log: garden.log,
      ctx,
    })

    expect(imageHash.stdout.trim()).to.equal("ok")
  }

  grouped("kaniko", "remote-only").context("using an external cluster registry with kaniko", () => {
    let module: GardenModule

    before(async () => {
      await init("kaniko-remote-registry")

      module = graph.getModule("remote-registry-test")

      // build the image
      await garden.buildStaging.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should pull the image", async () => {
      await removeImage(module)
      await pullModule(ctx as KubernetesPluginContext, module, garden.log)
      await ensureImagePulled(module)
    })
  })

  grouped("kaniko").context("using the in cluster registry with kaniko", () => {
    let module: GardenModule

    before(async () => {
      await init("kaniko")

      module = graph.getModule("simple-service")

      // build the image
      await garden.buildStaging.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should pull the image", async () => {
      await removeImage(module)
      await pullModule(ctx as KubernetesPluginContext, module, garden.log)
      await ensureImagePulled(module)
    })
  })

  grouped("cluster-buildkit", "remote-only").context("using an external cluster registry with buildkit", () => {
    let module: GardenModule

    before(async () => {
      await init("cluster-buildkit-remote-registry")

      module = graph.getModule("remote-registry-test")

      // build the image
      await garden.buildStaging.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should pull the image", async () => {
      await removeImage(module)
      await pullModule(ctx as KubernetesPluginContext, module, garden.log)
      await ensureImagePulled(module)
    })
  })

  grouped("cluster-buildkit").context("using the in cluster registry with buildkit", () => {
    let module: GardenModule

    before(async () => {
      await init("cluster-buildkit")

      module = graph.getModule("simple-service")

      // build the image
      await garden.buildStaging.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should pull the image", async () => {
      await removeImage(module)
      await pullModule(ctx as KubernetesPluginContext, module, garden.log)
      await ensureImagePulled(module)
    })
  })
})
