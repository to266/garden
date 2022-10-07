/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { cloneDeep, isArray, isString, keyBy } from "lodash"
import { validateWithPath } from "./config/validation"
import {
  resolveTemplateStrings,
  getModuleTemplateReferences,
  resolveTemplateString,
  mayContainTemplateString,
} from "./template-string/template-string"
import { ContextResolveOpts, GenericContext } from "./config/template-contexts/base"
import { relative, resolve, posix, dirname } from "path"
import { Garden } from "./garden"
import { ConfigurationError, FilesystemError, PluginError } from "./exceptions"
import { deline, dedent } from "./util/string"
import { getModuleKey, ModuleConfigMap, GardenModule, ModuleMap, moduleFromConfig } from "./types/module"
import { getModuleTypeBases } from "./plugins"
import { ModuleConfig, moduleConfigSchema } from "./config/module"
import { Profile } from "./util/profiling"
import { getLinkedSources } from "./util/ext-source-util"
import { allowUnknown, DeepPrimitiveMap } from "./config/common"
import { ProviderMap } from "./config/provider"
import { RuntimeContext } from "./runtime-context"
import chalk from "chalk"
import { DependencyValidationGraph } from "./util/validate-dependencies"
import Bluebird from "bluebird"
import { readFile, mkdirp, writeFile } from "fs-extra"
import { LogEntry } from "./logger/log-entry"
import { ModuleConfigContext, ModuleConfigContextParams } from "./config/template-contexts/module"
import { pathToCacheContext } from "./cache"
import { loadVarfile } from "./config/base"
import { merge } from "json-merge-patch"
import { prepareBuildDependencies } from "./config/base"
import { ModuleTypeDefinition, ModuleTypeMap } from "./types/plugin/plugin"

// This limit is fairly arbitrary, but we need to have some cap on concurrent processing.
export const moduleResolutionConcurrencyLimit = 50

/**
 * Resolves a set of module configurations in dependency order.
 *
 * This operates differently than the TaskGraph in that it can add dependency links as it proceeds through the modules,
 * which is important because dependencies can be discovered mid-stream, and the TaskGraph currently needs to
 * statically resolve all dependencies before processing tasks.
 */
@Profile()
export class ModuleResolver {
  private garden: Garden
  private log: LogEntry
  private rawConfigsByKey: ModuleConfigMap
  private resolvedProviders: ProviderMap
  private runtimeContext?: RuntimeContext
  private bases: { [type: string]: ModuleTypeDefinition[] }

  constructor({
    garden,
    log,
    rawConfigs,
    resolvedProviders,
    runtimeContext,
  }: {
    garden: Garden
    log: LogEntry
    rawConfigs: ModuleConfig[]
    resolvedProviders: ProviderMap
    runtimeContext?: RuntimeContext
  }) {
    this.garden = garden
    this.log = log
    this.rawConfigsByKey = keyBy(rawConfigs, (c) => getModuleKey(c.name, c.plugin))
    this.resolvedProviders = resolvedProviders
    this.runtimeContext = runtimeContext
    this.bases = {}
  }

  async resolveAll() {
    // Collect template references for every raw config and work out module references in templates and explicit
    // dependency references. We use two graphs, one will be fully populated as we progress, the other we gradually
    // remove nodes from as we complete the processing.
    const fullGraph = new DependencyValidationGraph()
    const processingGraph = new DependencyValidationGraph()

    for (const key of Object.keys(this.rawConfigsByKey)) {
      for (const graph of [fullGraph, processingGraph]) {
        graph.addNode(key)
      }
    }
    for (const [key, rawConfig] of Object.entries(this.rawConfigsByKey)) {
      const buildPath = this.garden.buildStaging.getBuildPath(rawConfig)
      const deps = this.getModuleDependenciesFromConfig(rawConfig, buildPath)
      for (const graph of [fullGraph, processingGraph]) {
        for (const dep of deps) {
          const depKey = getModuleKey(dep.name, dep.plugin)
          graph.addNode(depKey)
          graph.addDependency(key, depKey)
        }
      }
    }

    const resolvedConfigs: ModuleConfigMap = {}
    const resolvedModules: ModuleMap = {}
    const errors: { [moduleName: string]: Error } = {}

    const inFlight = new Set<string>()

    const processNode = async (moduleKey: string) => {
      if (inFlight.has(moduleKey)) {
        return
      }

      this.log.silly(`ModuleResolver: Process node ${moduleKey}`)
      inFlight.add(moduleKey)

      // Resolve configuration, unless previously resolved.
      let resolvedConfig = resolvedConfigs[moduleKey]
      let foundNewDependency = false

      const dependencyNames = fullGraph.dependenciesOf(moduleKey)
      const resolvedDependencies = dependencyNames.map((n) => resolvedModules[n])

      try {
        if (!resolvedConfig) {
          const rawConfig = this.rawConfigsByKey[moduleKey]

          this.log.silly(`ModuleResolver: Resolve config ${moduleKey}`)
          resolvedConfig = resolvedConfigs[moduleKey] = await this.resolveModuleConfig(rawConfig, resolvedDependencies)

          // Check if any new build dependencies were added by the configure handler
          for (const dep of resolvedConfig.build.dependencies) {
            const depKey = getModuleKey(dep.name, dep.plugin)

            if (!dependencyNames.includes(depKey)) {
              this.log.silly(`ModuleResolver: Found new dependency ${depKey} when resolving ${moduleKey}`)

              // We throw if the build dependency can't be found at all
              if (!fullGraph.hasNode(depKey)) {
                throw missingBuildDependency(rawConfig.name, depKey)
              }
              fullGraph.addDependency(moduleKey, depKey)

              foundNewDependency = true

              // The dependency may already have been processed, we don't want to add it to the graph in that case
              if (processingGraph.hasNode(depKey)) {
                this.log.silly(`ModuleResolver: Need to re-resolve ${moduleKey} after processing new dependencies`)
                processingGraph.addDependency(moduleKey, depKey)
              }
            }
          }
        }

        // If no unresolved build dependency was added, fully resolve the module and remove from graph, otherwise keep
        // it in the graph and move on to make sure we fully resolve the dependencies and don't run into circular
        // dependencies.
        if (!foundNewDependency) {
          const buildPath = this.garden.buildStaging.getBuildPath(resolvedConfig)
          resolvedModules[moduleKey] = await this.resolveModule(resolvedConfig, buildPath, resolvedDependencies)
          this.log.silly(`ModuleResolver: Module ${moduleKey} resolved`)
          processingGraph.removeNode(moduleKey)
        }
      } catch (err) {
        this.log.silly(`ModuleResolver: Node ${moduleKey} failed: ${err.message}`)
        errors[moduleKey] = err
      }

      inFlight.delete(moduleKey)
      return processLeaves()
    }

    const processLeaves = async () => {
      if (Object.keys(errors).length > 0) {
        const errorStr = Object.entries(errors)
          .map(([name, err]) => `${chalk.white.bold(name)}: ${err.message}`)
          .join("\n")
        const errorStack = Object.entries(errors)
          .map(([name, err]) => `${chalk.white.bold(name)}: ${err.stack || err.message}`)
          .join("\n\n")

        const msg = `Failed resolving one or more modules:\n\n${errorStr}`

        const combined = new ConfigurationError(chalk.red(msg), { ...errors })
        combined.stack = errorStack
        throw combined
      }

      // Get batch of leaf nodes (ones with no unresolved dependencies). Implicitly checks for circular dependencies.
      let batch: string[]

      try {
        batch = processingGraph.overallOrder(true).filter((n) => !inFlight.has(n))
      } catch (err) {
        throw new ConfigurationError(
          dedent`
            Detected circular dependencies between module configurations:

            ${err.detail?.["circular-dependencies"] || err.message}
          `,
          { cycles: err.detail?.cycles }
        )
      }

      this.log.silly(`ModuleResolver: Process ${batch.length} leaves`)

      if (batch.length === 0) {
        return
      }

      const overLimit = inFlight.size + batch.length - moduleResolutionConcurrencyLimit

      if (overLimit > 0) {
        batch = batch.slice(batch.length - overLimit)
      }

      // Process each of the leaf node module configs.
      await Bluebird.map(batch, processNode)
    }

    // Iterate through dependency graph, a batch of leaves at a time. While there are items remaining:
    let i = 0

    while (processingGraph.size() > 0) {
      this.log.silly(`ModuleResolver: Loop ${++i}`)
      await processLeaves()
    }

    return Object.values(resolvedModules)
  }

  /**
   * Returns module configs for each module that is referenced in a ${modules.*} template string in the raw config,
   * as well as any immediately resolvable declared build dependencies.
   */
  private getModuleDependenciesFromConfig(rawConfig: ModuleConfig, buildPath: string) {
    const configContext = new ModuleConfigContext({
      garden: this.garden,
      variables: this.garden.variables,
      resolvedProviders: this.resolvedProviders,
      moduleConfig: rawConfig,
      buildPath,
      modules: [],
      runtimeContext: this.runtimeContext,
      partialRuntimeResolution: true,
    })

    const templateRefs = getModuleTemplateReferences(rawConfig, configContext)
    const templateDeps = <string[]>templateRefs.filter((d) => d[1] !== rawConfig.name).map((d) => d[1])

    // Try resolving template strings if possible
    let buildDeps: string[] = []
    const resolvedDeps = resolveTemplateStrings(rawConfig.build.dependencies, configContext, { allowPartial: true })

    // The build.dependencies field may not resolve at all, in which case we can't extract any deps from there
    if (isArray(resolvedDeps)) {
      buildDeps = resolvedDeps
        // We only collect fully-resolved references here
        .filter((d) => !mayContainTemplateString(d) && (isString(d) || d.name))
        .map((d) => (isString(d) ? d : getModuleKey(d.name, d.plugin)))
    }

    const deps = [...templateDeps, ...buildDeps]

    return deps.map((name) => {
      const moduleConfig = this.rawConfigsByKey[name]

      if (!moduleConfig) {
        throw missingBuildDependency(rawConfig.name, name as string)
      }

      return moduleConfig
    })
  }

  /**
   * Resolves and validates a single module configuration.
   */
  async resolveModuleConfig(config: ModuleConfig, dependencies: GardenModule[]): Promise<ModuleConfig> {
    const garden = this.garden
    let inputs = {}

    const buildPath = this.garden.buildStaging.getBuildPath(config)

    const templateContextParams: ModuleConfigContextParams = {
      garden,
      variables: garden.variables,
      resolvedProviders: this.resolvedProviders,
      modules: dependencies,
      moduleConfig: config,
      buildPath,
      runtimeContext: this.runtimeContext,
      partialRuntimeResolution: true,
    }

    // Resolve and validate the inputs field, because template module inputs may not be fully resolved at this
    // time.
    // TODO: This whole complicated procedure could be much improved and simplified by implementing lazy resolution on
    // values... I'll be looking into that. - JE
    const templateName = config.templateName

    if (templateName) {
      const template = this.garden.moduleTemplates[templateName]

      inputs = resolveTemplateStrings(
        inputs,
        new ModuleConfigContext(templateContextParams),
        // Not all inputs may need to be resolvable
        { allowPartial: true }
      )

      inputs = validateWithPath({
        config: cloneDeep(config.inputs || {}),
        configType: `inputs for module ${config.name}`,
        path: config.configPath || config.path,
        schema: template.inputsSchema,
        projectRoot: garden.projectRoot,
      })

      config.inputs = inputs
    }

    // Resolve the variables field before resolving everything else (overriding with module varfiles if present)
    const resolvedModuleVariables = await this.resolveVariables(config, templateContextParams)

    // Now resolve just references to inputs on the config
    config = resolveTemplateStrings(cloneDeep(config), new GenericContext({ inputs }), {
      allowPartial: true,
    })

    // And finally fully resolve the config
    const configContext = new ModuleConfigContext({
      ...templateContextParams,
      moduleConfig: config,
      variables: { ...garden.variables, ...resolvedModuleVariables },
    })

    config = resolveTemplateStrings({ ...config, inputs: {}, variables: {} }, configContext, {
      allowPartial: false,
    })

    config.variables = resolvedModuleVariables
    config.inputs = inputs

    const moduleTypeDefinitions = await garden.getModuleTypes()
    const description = moduleTypeDefinitions[config.type]

    if (!description) {
      const configPath = relative(garden.projectRoot, config.configPath || config.path)

      throw new ConfigurationError(
        deline`
        Unrecognized module type '${config.type}' (defined at ${configPath}).
        Are you missing a provider configuration?
        `,
        { config, configuredModuleTypes: Object.keys(moduleTypeDefinitions) }
      )
    }

    // We allow specifying modules by name only as a shorthand:
    //
    // dependencies:
    //   - foo-module
    //   - name: foo-module // same as the above
    //
    // Empty strings and nulls are omitted from the array.
    if (config.build && config.build.dependencies) {
      config.build.dependencies = prepareBuildDependencies(config.build.dependencies).filter((dep) => dep.name)
    }

    // We need to refilter the build dependencies on the spec in case one or more dependency names resolved to null.
    if (config.spec.build && config.spec.build.dependencies) {
      config.spec.build.dependencies = prepareBuildDependencies(config.spec.build.dependencies)
    }

    // Validate the module-type specific spec
    if (description.schema) {
      config.spec = validateWithPath({
        config: config.spec,
        configType: "Module",
        schema: description.schema,
        name: config.name,
        path: config.path,
        projectRoot: garden.projectRoot,
      })
    }

    // Validate the base config schema
    config = validateWithPath({
      config,
      schema: moduleConfigSchema(),
      configType: "module",
      name: config.name,
      path: config.path,
      projectRoot: garden.projectRoot,
    })

    if (config.repositoryUrl) {
      const linkedSources = await getLinkedSources(garden, "module")
      config.path = await garden.loadExtSourcePath({
        name: config.name,
        linkedSources,
        repositoryUrl: config.repositoryUrl,
        sourceType: "module",
      })
    }

    const actions = await garden.getActionRouter()
    const configureResult = await actions.configureModule({
      moduleConfig: config,
      log: garden.log,
    })

    config = configureResult.moduleConfig

    // Validate the configure handler output against the module type's bases
    const bases = this.getBases(config.type, moduleTypeDefinitions)

    for (const base of bases) {
      if (base.schema) {
        garden.log.silly(`Validating '${config.name}' config against '${base.name}' schema`)

        config.spec = <ModuleConfig>validateWithPath({
          config: config.spec,
          schema: base.schema,
          path: garden.projectRoot,
          projectRoot: garden.projectRoot,
          configType: `configuration for module '${config.name}' (base schema from '${base.name}' plugin)`,
          ErrorClass: ConfigurationError,
        })
      }
    }

    // FIXME: We should be able to avoid this
    config.name = getModuleKey(config.name, config.plugin)

    if (config.plugin) {
      for (const serviceConfig of config.serviceConfigs) {
        serviceConfig.name = getModuleKey(serviceConfig.name, config.plugin)
      }
      for (const taskConfig of config.taskConfigs) {
        taskConfig.name = getModuleKey(taskConfig.name, config.plugin)
      }
      for (const testConfig of config.testConfigs) {
        testConfig.name = getModuleKey(testConfig.name, config.plugin)
      }
    }

    return config
  }

  /**
   * Get the bases for the given module type, with schemas modified to allow any unknown fields.
   */
  private getBases(type: string, definitions: ModuleTypeMap) {
    if (this.bases[type]) {
      return this.bases[type]
    }

    const bases = getModuleTypeBases(definitions[type], definitions)
    this.bases[type] = bases.map((b) => ({ ...b, schema: b.schema ? allowUnknown(b.schema) : undefined }))
    return this.bases[type]
  }

  private async resolveModule(resolvedConfig: ModuleConfig, buildPath: string, dependencies: GardenModule[]) {
    this.log.silly(`Resolving module ${resolvedConfig.name}`)

    // Write module files
    const configContext = new ModuleConfigContext({
      garden: this.garden,
      resolvedProviders: this.resolvedProviders,
      variables: { ...this.garden.variables, ...resolvedConfig.variables },
      moduleConfig: resolvedConfig,
      buildPath,
      modules: dependencies,
      runtimeContext: this.runtimeContext,
      partialRuntimeResolution: true,
    })

    let updatedFiles = false

    await Bluebird.map(resolvedConfig.generateFiles || [], async (fileSpec) => {
      let contents = fileSpec.value || ""

      if (fileSpec.sourcePath) {
        const configDir = resolvedConfig.configPath ? dirname(resolvedConfig.configPath) : resolvedConfig.path
        const sourcePath = resolve(configDir, fileSpec.sourcePath)

        try {
          contents = (await readFile(sourcePath)).toString()
        } catch (err) {
          throw new ConfigurationError(
            `Unable to read file at ${sourcePath}, specified under generateFiles in module ${resolvedConfig.name}: ${err}`,
            {
              sourcePath,
            }
          )
        }
      }

      const resolvedContents = fileSpec.resolveTemplates
        ? resolveTemplateString(contents, configContext, { unescape: true })
        : contents

      const targetDir = resolve(resolvedConfig.path, ...posix.dirname(fileSpec.targetPath).split(posix.sep))
      const targetPath = resolve(resolvedConfig.path, ...fileSpec.targetPath.split(posix.sep))

      // Avoid unnecessary write + invalidating caches on the module path if no changes are made
      try {
        const prior = (await readFile(targetPath)).toString()
        if (prior === resolvedContents) {
          // No change, abort
          return
        } else {
          // File is modified, proceed and flag for cache invalidation
          updatedFiles = true
        }
      } catch {
        // File doesn't exist, proceed and flag for cache invalidation
        updatedFiles = true
      }

      try {
        await mkdirp(targetDir)
        await writeFile(targetPath, resolvedContents)
      } catch (error) {
        throw new FilesystemError(
          `Unable to write templated file ${fileSpec.targetPath} from ${resolvedConfig.name}: ${error.message}`,
          {
            fileSpec,
            error,
          }
        )
      }
    })

    // Make sure version is re-computed after writing new/updated files
    if (updatedFiles) {
      const cacheContext = pathToCacheContext(resolvedConfig.path)
      this.garden.cache.invalidateUp(this.log, cacheContext)
    }

    const module = await moduleFromConfig({
      garden: this.garden,
      log: this.log,
      config: resolvedConfig,
      buildDependencies: dependencies,
    })

    const moduleTypeDefinitions = await this.garden.getModuleTypes()
    const description = moduleTypeDefinitions[module.type]!

    // Validate the module outputs against the outputs schema
    if (description.moduleOutputsSchema) {
      module.outputs = validateWithPath({
        config: module.outputs,
        schema: description.moduleOutputsSchema,
        configType: `outputs for module`,
        name: module.name,
        path: module.configPath || module.path,
        projectRoot: this.garden.projectRoot,
        ErrorClass: PluginError,
      })
    }

    // Validate the module outputs against the module type's bases
    const bases = this.getBases(module.type, moduleTypeDefinitions)

    for (const base of bases) {
      if (base.moduleOutputsSchema) {
        this.log.silly(`Validating '${module.name}' module outputs against '${base.name}' schema`)

        module.outputs = validateWithPath({
          config: module.outputs,
          schema: base.moduleOutputsSchema.unknown(true),
          path: module.configPath || module.path,
          projectRoot: this.garden.projectRoot,
          configType: `outputs for module '${module.name}' (base schema from '${base.name}' plugin)`,
          ErrorClass: PluginError,
        })
      }
    }
    return module
  }

  /**
   * Resolves module variables with the following precedence order:
   *
   *   garden.cliVariables > module varfile > config.variables
   */
  private async resolveVariables(
    config: ModuleConfig,
    templateContextParams: ModuleConfigContextParams
  ): Promise<DeepPrimitiveMap> {
    const moduleConfigContext = new ModuleConfigContext(templateContextParams)
    const resolveOpts = { allowPartial: false }
    let varfileVars: DeepPrimitiveMap = {}
    if (config.varfile) {
      const varfilePath = resolveTemplateString(config.varfile, moduleConfigContext, resolveOpts)
      varfileVars = await loadVarfile({
        configRoot: config.path,
        path: varfilePath,
        defaultPath: undefined,
      })
    }

    const rawVariables = config.variables
    const moduleVariables = resolveTemplateStrings(cloneDeep(rawVariables || {}), moduleConfigContext, resolveOpts)
    const mergedVariables: DeepPrimitiveMap = <any>merge(moduleVariables, merge(varfileVars, this.garden.cliVariables))
    return mergedVariables
  }
}

export interface ModuleConfigResolveOpts extends ContextResolveOpts {
  configContext: ModuleConfigContext
}

function missingBuildDependency(moduleName: string, dependencyName: string) {
  return new ConfigurationError(
    chalk.red(
      `Could not find build dependency ${chalk.white(dependencyName)}, ` +
        `configured in module ${chalk.white(moduleName)}`
    ),
    { moduleName, dependencyName }
  )
}
