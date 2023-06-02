/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve } from "path"
import { readFile } from "fs-extra"
import Bluebird from "bluebird"
import { flatten, keyBy, set } from "lodash"
import { safeLoadAll } from "js-yaml"

import { KubernetesModule } from "./module-config"
import { KubernetesResource } from "../types"
import { KubeApi } from "../api"
import { gardenAnnotationKey, stableStringify } from "../../../util/string"
import { Log } from "../../../logger/log-entry"
import { PluginContext } from "../../../plugin-context"
import { ConfigurationError, PluginError } from "../../../exceptions"
import { KubernetesPluginContext, KubernetesTargetResourceSpec, ServiceResourceSpec } from "../config"
import { HelmModule } from "../helm/module-config"
import { KubernetesDeployAction } from "./config"
import { CommonRunParams } from "../../../plugin/handlers/Run/run"
import { runAndCopy } from "../run"
import { getTargetResource, getResourcePodSpec, getResourceContainer, makePodName, getResourceKey } from "../util"
import { ActionMode, Resolved } from "../../../actions/types"
import { KubernetesPodRunAction, KubernetesPodTestAction } from "./kubernetes-pod"
import { V1ConfigMap } from "@kubernetes/client-node"

/**
 * Reads the manifests and makes sure each has a namespace set (when applicable) and adds annotations.
 * Use this when applying to the cluster, or comparing against deployed resources.
 */
export async function getManifests({
  ctx,
  api,
  log,
  action,
  defaultNamespace,
}: {
  ctx: PluginContext
  api: KubeApi
  log: Log
  action: Resolved<KubernetesDeployAction | KubernetesPodRunAction | KubernetesPodTestAction>
  defaultNamespace: string
}): Promise<KubernetesResource[]> {
  const rawManifests = (await readManifests(ctx, action, log)) as KubernetesResource[]

  // remove *List objects
  const manifests = rawManifests.flatMap((manifest) => {
    if (manifest.kind.endsWith("List")) {
      if (!manifest.items || manifest.items.length === 0) {
        // empty list
        return []
      } else if (manifest.items.length > 0 && manifest.items[0].kind) {
        // at least the first manifest has a kind: seems to be a valid List
        return manifest.items as KubernetesResource[]
      } else {
        throw new PluginError("Failed to read Kubernetes manifest: Encountered an invalid List manifest", {
          manifest,
        })
      }
    }
    return manifest
  })

  if (action.kind === "Deploy") {
    // Add metadata ConfigMap to aid quick status check
    manifests.push(getMetadataManifest(action, defaultNamespace, manifests))
  }

  return Bluebird.map(manifests, async (manifest) => {
    // Ensure a namespace is set, if not already set, and if required by the resource type
    if (!manifest.metadata?.namespace) {
      if (!manifest.metadata) {
        // TODO: Type system complains that name is missing
        ;(manifest as any).metadata = {}
      }

      const info = await api.getApiResourceInfo(log, manifest.apiVersion, manifest.kind)

      if (info?.namespaced) {
        manifest.metadata.namespace = defaultNamespace
      }
    }

    /**
     * Set Garden annotations.
     *
     * For namespace resources, we use the namespace's name as the annotation value, to ensure that namespace resources
     * with different names aren't considered by Garden to be the same resource.
     *
     * This is relevant e.g. in the context of a shared dev cluster, where several users might create their own
     * copies of a namespace resource (each named e.g. "${username}-some-namespace") through deploying a `kubernetes`
     * module that includes a namespace resource in its manifests.
     */
    const annotationValue =
      manifest.kind === "Namespace" ? gardenNamespaceAnnotationValue(manifest.metadata.name) : action.name
    set(manifest, ["metadata", "annotations", gardenAnnotationKey("service")], annotationValue)
    set(manifest, ["metadata", "annotations", gardenAnnotationKey("mode")], action.mode())
    set(manifest, ["metadata", "labels", gardenAnnotationKey("service")], annotationValue)

    return manifest
  })
}

export interface ManifestMetadata {
  key: string
  apiVersion: string
  kind: string
  name: string
  namespace: string
}

export interface ParsedMetadataManifestData {
  resolvedVersion: string
  mode: ActionMode
  manifestMetadata: { [key: string]: ManifestMetadata }
}

export function getMetadataManifest(
  action: Resolved<KubernetesDeployAction>,
  defaultNamespace: string,
  manifests: KubernetesResource[]
): KubernetesResource<V1ConfigMap> {
  const manifestMetadata: ManifestMetadata[] = manifests.map((m) => ({
    key: getResourceKey(m),
    apiVersion: m.apiVersion,
    kind: m.kind,
    name: m.metadata.name,
    namespace: m.metadata.namespace || defaultNamespace,
  }))

  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `garden-meta-${action.kind.toLowerCase()}-${action.name}`,
    },
    data: {
      resolvedVersion: action.versionString(),
      mode: action.mode(),
      manifestMetadata: stableStringify(keyBy(manifestMetadata, "key")),
    },
  }
}

export function parseMetadataResource(log: Log, resource: KubernetesResource<V1ConfigMap>): ParsedMetadataManifestData {
  // TODO: validate schema here
  const output: ParsedMetadataManifestData = {
    resolvedVersion: resource.data?.resolvedVersion || "",
    mode: (resource.data?.mode || "default") as ActionMode,
    manifestMetadata: {},
  }

  const manifestMetadata = resource.data?.manifestMetadata

  if (manifestMetadata) {
    try {
      // TODO: validate by schema
      output.manifestMetadata = JSON.parse(manifestMetadata)
    } catch (error) {
      log.debug({ msg: `Failed querying for remote resources: ${error.message}`, error })
    }
  }

  return output
}

const disallowedKustomizeArgs = ["-o", "--output", "-h", "--help"]

/**
 * Read the manifests from the module config, as well as any referenced files in the config.
 */
export async function readManifests(
  ctx: PluginContext,
  action: Resolved<KubernetesDeployAction | KubernetesPodRunAction | KubernetesPodTestAction>,
  log: Log
) {
  const manifestPath = action.getBuildPath()

  const spec = action.getSpec()

  const fileManifests = flatten(
    await Bluebird.map(spec.files, async (path) => {
      const absPath = resolve(manifestPath, path)
      log.debug(`Reading manifest for module ${action.name} from path ${absPath}`)
      const str = (await readFile(absPath)).toString()
      const resolved = ctx.resolveTemplateStrings(str, { allowPartial: true, unescape: true })
      return safeLoadAll(resolved)
    })
  )

  let kustomizeManifests: any[] = []

  if (spec.kustomize?.path) {
    const kustomize = ctx.tools["kubernetes.kustomize"]

    const extraArgs = spec.kustomize.extraArgs || []

    for (const arg of disallowedKustomizeArgs) {
      if (extraArgs.includes(arg)) {
        throw new ConfigurationError(
          `kustomize.extraArgs must not include any of ${disallowedKustomizeArgs.join(", ")}`,
          {
            spec,
            extraArgs,
          }
        )
      }
    }

    try {
      const kustomizeOutput = await kustomize.stdout({
        cwd: manifestPath,
        log,
        args: ["build", spec.kustomize.path, ...extraArgs],
      })
      kustomizeManifests = safeLoadAll(kustomizeOutput)
    } catch (error) {
      throw new PluginError(`Failed resolving kustomize manifests: ${error.message}`, {
        error,
        spec,
      })
    }
  }

  return [...spec.manifests, ...fileManifests, ...kustomizeManifests]
}

/**
 * We use this annotation value for namespace resources to avoid potential conflicts with module names (since module
 * names can't start with `garden`).
 */
export function gardenNamespaceAnnotationValue(namespaceName: string) {
  return `garden-namespace--${namespaceName}`
}

export function convertServiceResource(
  module: KubernetesModule | HelmModule,
  serviceResourceSpec?: ServiceResourceSpec,
  defaultName?: string
): KubernetesTargetResourceSpec | null {
  const s = serviceResourceSpec || module.spec.serviceResource

  if (!s) {
    return null
  }

  return {
    kind: s.kind,
    name: s.name || defaultName || module.name,
    podSelector: s.podSelector,
    containerName: s.containerName,
  }
}

export async function runOrTestWithPod(
  params: CommonRunParams & {
    ctx: KubernetesPluginContext
    action: Resolved<KubernetesPodRunAction | KubernetesPodTestAction>
    log: Log
    namespace: string
  }
) {
  const { ctx, action, log, namespace } = params
  // Get the container spec to use for running
  const spec = action.getSpec()
  const version = action.versionString()

  let podSpec = spec.podSpec
  let container = spec.podSpec?.containers[0]

  if (!podSpec) {
    const resourceSpec = spec.resource

    if (!resourceSpec) {
      // Note: This will generally be caught in schema validation.
      throw new ConfigurationError(`${action.longDescription()} specified neither podSpec nor resource.`, { spec })
    }
    const k8sCtx = <KubernetesPluginContext>ctx
    const provider = k8sCtx.provider
    const api = await KubeApi.factory(log, ctx, provider)
    const manifests = await getManifests({ ctx, api, log, action, defaultNamespace: namespace })
    const target = await getTargetResource({
      ctx,
      log,
      provider: ctx.provider,
      action,
      manifests,
      query: resourceSpec,
    })
    podSpec = getResourcePodSpec(target)
    container = getResourceContainer(target, resourceSpec.containerName)
  } else if (!container) {
    throw new ConfigurationError(
      `${action.longDescription()} specified a podSpec without containers. Please make sure there is at least one container in the spec.`,
      { spec }
    )
  }

  return runAndCopy({
    ...params,
    container,
    podSpec,
    command: spec.command,
    args: spec.args,
    artifacts: spec.artifacts,
    envVars: spec.env,
    image: container.image!,
    namespace,
    podName: makePodName(action.kind.toLowerCase(), action.name),
    timeout: action.getConfig().timeout,
    version,
  })
}
