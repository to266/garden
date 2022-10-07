/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { cloneDeep, flatten, isPlainObject } from "lodash"
import { join, resolve } from "path"
import { pathExists, readFile, remove, writeFile } from "fs-extra"
import { apply as jsonMerge } from "json-merge-patch"

import { PluginContext } from "../../../plugin-context"
import { LogEntry } from "../../../logger/log-entry"
import { getModuleNamespace } from "../namespace"
import { KubernetesResource } from "../types"
import { loadAll } from "js-yaml"
import { helm } from "./helm-cli"
import { HelmModule, HelmModuleConfig } from "./config"
import { ConfigurationError, PluginError } from "../../../exceptions"
import { GardenModule } from "../../../types/module"
import { deline, tailString } from "../../../util/string"
import { flattenResources, getAnnotation } from "../util"
import { KubernetesPluginContext } from "../config"
import { RunResult } from "../../../types/plugin/base"
import { MAX_RUN_RESULT_LOG_LENGTH } from "../constants"
import { dumpYaml } from "../../../util/util"
import cryptoRandomString = require("crypto-random-string")

const gardenValuesFilename = "garden-values.yml"

interface Chart {
  apiVersion: string
  dependencies?: { name: string }[]
}

async function containsChart(basePath: string, config: HelmModuleConfig) {
  const yamlPath = join(basePath, config.spec.chartPath, "Chart.yaml")
  return pathExists(yamlPath)
}

async function dependencyUpdate(ctx: KubernetesPluginContext, log: LogEntry, namespace: string, chartPath: string) {
  await helm({
    ctx,
    log,
    namespace,
    args: ["dependency", "update", chartPath],
  })
}

/**
 * Returns true if the specified Helm module contains a template (as opposed to just referencing a remote template).
 */
export async function containsSource(config: HelmModuleConfig) {
  return containsChart(config.path, config)
}

/**
 * Returns true if the specified Helm module contains a template in its build path (as opposed to just referencing
 * a remote template).
 */
export async function containsBuildSource(module: HelmModule) {
  return containsChart(module.buildPath, module)
}

interface GetChartResourcesParams {
  ctx: KubernetesPluginContext
  module: GardenModule
  devMode: boolean
  hotReload: boolean
  localMode: boolean
  log: LogEntry
  version: string
}

type PrepareManifestsParams = GetChartResourcesParams & {
  namespace: string
  releaseName: string
  chartPath: string
}

/**
 * Render the template in the specified Helm module (locally), and return all the resources in the chart.
 */
export async function getChartResources(params: GetChartResourcesParams) {
  return filterManifests(await renderTemplates(params))
}

/**
 * Renders the given Helm module and returns a multi-document YAML string.
 */
export async function renderTemplates(params: GetChartResourcesParams): Promise<string> {
  const { ctx, module, devMode, hotReload, localMode, version, log } = params
  const { namespace, releaseName, chartPath } = await prepareTemplates(params)

  log.debug("Preparing chart...")

  return await prepareManifests({
    ctx,
    module,
    devMode,
    hotReload,
    localMode,
    version,
    log,
    namespace,
    releaseName,
    chartPath,
  })
}

export async function prepareTemplates({
  ctx,
  module,
  log,
  version,
}: GetChartResourcesParams): Promise<{ namespace: string; releaseName: string; chartPath: string }> {
  const chartPath = await getChartPath(module)

  // create the values.yml file (merge the configured parameters into the default values)
  // Merge with the base module's values, if applicable
  let specValues = module.spec.values || {}

  const baseModule = getBaseModule(module)
  if (baseModule) {
    specValues = jsonMerge(cloneDeep(baseModule.spec.values), specValues)
  }

  // Add Garden metadata
  specValues[".garden"] = {
    moduleName: module.name,
    projectName: ctx.projectName,
    version,
  }

  const valuesPath = getGardenValuesPath(chartPath)
  log.silly(`Writing chart values to ${valuesPath}`)
  await dumpYaml(valuesPath, specValues)

  const releaseName = getReleaseName(module)
  const namespace = await getModuleNamespace({
    ctx,
    log,
    module,
    provider: ctx.provider,
    skipCreate: true,
  })

  if (await pathExists(join(chartPath, "requirements.yaml"))) {
    await dependencyUpdate(ctx, log, namespace, chartPath)
  }

  const chartYaml = join(chartPath, "Chart.yaml")
  if (await pathExists(chartYaml)) {
    const chart = <Chart[]>loadTemplate((await readFile(chartYaml)).toString())
    if (chart[0].dependencies?.length) {
      await dependencyUpdate(ctx, log, namespace, chartPath)
    }
  }
  return { namespace, releaseName, chartPath }
}

export async function prepareManifests(params: PrepareManifestsParams): Promise<string> {
  const { ctx, module, devMode, hotReload, localMode, log, namespace, releaseName, chartPath } = params
  const res = await helm({
    ctx,
    log,
    namespace,
    args: [
      "install",
      releaseName,
      chartPath,
      "--dry-run",
      "--namespace",
      namespace,
      // Set output to JSON so that we can get just the manifests. The default output contains notes and additional data
      "--output",
      "json",
      "--timeout",
      module.spec.timeout.toString(10) + "s",
      ...(await getValueArgs(module, devMode, hotReload, localMode)),
    ],
  })

  const manifest = JSON.parse(res).manifest as string
  return manifest
}

export async function filterManifests(renderedTemplates: string) {
  const objects = <KubernetesResource[]>loadTemplate(renderedTemplates)

  const resources = objects.filter((obj) => {
    // Don't try to check status of hooks
    const helmHook = getAnnotation(obj, "helm.sh/hook")
    if (helmHook) {
      return false
    }

    // Ephemeral objects should also not be checked
    if (obj.kind === "Pod" || obj.kind === "Job") {
      return false
    }

    return true
  })

  return flattenResources(resources)
}

/**
 * Returns the base module of the specified Helm module, or undefined if none is specified.
 * Throws an error if the referenced module is missing, or is not a Helm module.
 */
export function getBaseModule(module: HelmModule) {
  if (!module.spec.base) {
    return
  }

  const baseModule = module.buildDependencies[module.spec.base]

  if (!baseModule) {
    throw new PluginError(
      deline`Helm module '${module.name}' references base module '${module.spec.base}'
      but it is missing from the module's build dependencies.`,
      { moduleName: module.name, baseModuleName: module.spec.base }
    )
  }

  if (baseModule.type !== "helm") {
    throw new ConfigurationError(
      deline`Helm module '${module.name}' references base module '${module.spec.base}'
      which is a '${baseModule.type}' module, but should be a helm module.`,
      { moduleName: module.name, baseModuleName: module.spec.base, baseModuleType: baseModule.type }
    )
  }

  return baseModule
}

/**
 * Get the full path to the chart, within the module build directory.
 */
export async function getChartPath(module: HelmModule) {
  const baseModule = getBaseModule(module)

  if (baseModule) {
    return join(module.buildPath, baseModule.spec.chartPath)
  } else if (await containsBuildSource(module)) {
    return join(module.buildPath, module.spec.chartPath)
  } else {
    // This value is validated to exist in the validate module action
    const splitName = module.spec.chart!.split("/")
    const chartDir = splitName[splitName.length - 1]
    return join(module.buildPath, chartDir)
  }
}

/**
 * Get the path to the values file that we generate (garden-values.yml) within the chart directory.
 */
export function getGardenValuesPath(chartPath: string) {
  return join(chartPath, gardenValuesFilename)
}

/**
 * Get the value files arguments that should be applied to any helm install/render command.
 */
export async function getValueArgs(module: HelmModule, devMode: boolean, hotReload: boolean, localMode: boolean) {
  const chartPath = await getChartPath(module)
  const gardenValuesPath = getGardenValuesPath(chartPath)

  // The garden-values.yml file (which is created from the `values` field in the module config) takes precedence,
  // so it's added to the end of the list.
  const valueFiles = module.spec.valueFiles.map((f) => resolve(module.buildPath, f)).concat([gardenValuesPath])

  const args = flatten(valueFiles.map((f) => ["--values", f]))

  // Local mode always takes precedence over dev mode
  if (localMode) {
    args.push("--set", "\\.garden.localMode=true")
  } else {
    if (devMode) {
      args.push("--set", "\\.garden.devMode=true")
    }
    if (hotReload) {
      args.push("--set", "\\.garden.hotReload=true")
    }
  }

  return args
}

/**
 * Get the release name to use for the module/chart (the module name, unless overridden in config).
 */
export function getReleaseName(config: HelmModuleConfig) {
  return config.spec.releaseName || config.name
}

/**
 * This is a dirty hack that allows us to resolve Helm template strings ad-hoc.
 * Basically this writes a dummy file to the chart, has Helm resolve it, and then deletes the file.
 */
export async function renderHelmTemplateString(
  ctx: PluginContext,
  log: LogEntry,
  module: HelmModule,
  chartPath: string,
  value: string
): Promise<string> {
  const relPath = join("templates", cryptoRandomString({ length: 16 }) + ".yaml")
  const tempFilePath = join(chartPath, relPath)
  const k8sCtx = <KubernetesPluginContext>ctx
  const namespace = await getModuleNamespace({
    ctx: k8sCtx,
    log,
    module,
    provider: k8sCtx.provider,
    skipCreate: true,
  })
  const releaseName = getReleaseName(module)

  try {
    // Need to add quotes for this to work as expected. Also makes sense since we only support string outputs here.
    await writeFile(tempFilePath, `value: '${value}'\n`)

    const objects = loadTemplate(
      await helm({
        ctx: k8sCtx,
        log,
        namespace,
        args: [
          "template",
          releaseName,
          "--namespace",
          namespace,
          "--dependency-update",
          ...(await getValueArgs(module, false, false, false)),
          "--show-only",
          relPath,
          chartPath,
        ],
      })
    )

    return objects[0].value
  } finally {
    await remove(tempFilePath)
  }
}

/**
 * Helm templates can include duplicate keys, e.g. because of a mistake in the remote chart repo.
 * We therefore load the template with `{ json: true }`, so that duplicate keys in a mapping will override values rather
 * than throwing an error.
 *
 * However, this behavior is broken for the `safeLoadAll` function, see: https://github.com/nodeca/js-yaml/issues/456.
 * We therefore need to use the `loadAll` function. See the following link for a conversation on using
 * `loadAll` in this context: https://github.com/kubeapps/kubeapps/issues/636.
 */
export function loadTemplate(template: string) {
  return loadAll(template || "", undefined, { json: true })
    .filter((obj) => obj !== null)
    .map((obj) => {
      if (isPlainObject(obj)) {
        if (!obj.metadata) {
          obj.metadata = {}
        }
        if (!obj.metadata.annotations) {
          obj.metadata.annotations = {}
        }
      }
      return obj
    })
}

export function trimRunOutput<T extends RunResult>(result: T): T {
  const log = tailString(result.log, MAX_RUN_RESULT_LOG_LENGTH, true)

  return {
    ...result,
    log,
  }
}
