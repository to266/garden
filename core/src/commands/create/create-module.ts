/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import dedent from "dedent"
import { pathExists } from "fs-extra"
import { Command, CommandResult, CommandParams } from "../base"
import { printHeader } from "../../logger/util"
import { isDirectory, defaultConfigFilename } from "../../util/fs"
import { loadConfigResources, findProjectConfig } from "../../config/base"
import { resolve, basename, relative, join } from "path"
import { GardenBaseError, ParameterError } from "../../exceptions"
import { getModuleTypes, getPluginBaseNames } from "../../plugins"
import { addConfig, createBaseOpts } from "./helpers"
import { getSupportedPlugins } from "../../plugins/plugins"
import { baseModuleSpecSchema } from "../../config/module"
import { renderConfigReference } from "../../docs/config"
import { DOCS_BASE_URL } from "../../constants"
import { flatten, keyBy } from "lodash"
import { fixedPlugins } from "../../config/project"
import { deline, wordWrap, truncate } from "../../util/string"
import { joi } from "../../config/common"
import { LoggerType } from "../../logger/logger"
import Bluebird from "bluebird"
import { ModuleTypeMap } from "../../types/plugin/plugin"
import { LogEntry } from "../../logger/log-entry"
import { getProviderUrl, getModuleTypeUrl } from "../../docs/common"
import { PathParameter, StringParameter, BooleanParameter, StringOption } from "../../cli/params"
import { userPrompt } from "../../util/util"

const createModuleArgs = {}
const createModuleOpts = {
  ...createBaseOpts,
  dir: new PathParameter({
    help: "Directory to place the module in (defaults to current directory).",
    defaultValue: ".",
  }),
  filename: new StringParameter({
    help: "Filename to place the module config in (defaults to garden.yml).",
    defaultValue: defaultConfigFilename,
  }),
  interactive: new BooleanParameter({
    alias: "i",
    help: "Set to false to disable interactive prompts.",
    defaultValue: true,
  }),
  name: new StringOption({
    help: "Name of the module (defaults to current directory name).",
  }),
  type: new StringOption({
    help: "The module type to create. Required if --interactive=false.",
  }),
}

type CreateModuleArgs = typeof createModuleArgs
type CreateModuleOpts = typeof createModuleOpts

interface CreateModuleResult {
  configPath: string
  name: string
  type: string
}

// TODO: move to common
class CreateError extends GardenBaseError {
  type: "create"
}

export class CreateModuleCommand extends Command<CreateModuleArgs, CreateModuleOpts> {
  name = "module"
  help = "Create a new Garden module."
  noProject = true
  cliOnly = true

  description = dedent`
    Creates a new Garden module configuration. The generated config includes some default values, as well as the
    schema of the config in the form of commentented-out fields.

    Examples:

        garden create module                      # create a Garden module config in the current directory
        garden create module --dir some-dir       # create a Garden module config in the ./some-dir directory
        garden create module --name my-module     # set the module name to my-module
        garden create module --interactive=false  # don't prompt for user inputs when creating the module
  `

  arguments = createModuleArgs
  options = createModuleOpts

  getLoggerType(): LoggerType {
    return "basic"
  }

  printHeader({ headerLog }) {
    printHeader(headerLog, "Create new module", "pencil2")
  }

  // Defining it like this because it'll stall on waiting for user input.
  isPersistent() {
    return true
  }

  async action({
    opts,
    log,
  }: CommandParams<CreateModuleArgs, CreateModuleOpts>): Promise<CommandResult<CreateModuleResult>> {
    const configDir = resolve(process.cwd(), opts.dir)

    if (!(await isDirectory(configDir))) {
      throw new ParameterError(`${configDir} is not a directory`, { configDir })
    }

    const configPath = join(configDir, opts.filename)

    let name = opts.name || basename(configDir)
    let type = opts.type
    let presetValues = {
      kind: "Module",
      name,
      type,
    }

    const allModuleTypes = getModuleTypes(getSupportedPlugins().map((p) => p.callback()))

    if (opts.interactive && (!opts.name || !opts.type)) {
      log.root.stop()

      if (!opts.type) {
        const choices = await getModuleTypeSuggestions(log, allModuleTypes, configDir, name)

        const answer = await userPrompt({
          name: "suggestion",
          message: "Select a module type:",
          type: "list",
          choices,
          pageSize: 20,
        })
        presetValues = answer.suggestion
        type = presetValues.type
      }

      if (!opts.name) {
        const answer = await userPrompt({
          name: "name",
          message: "Set the module name:",
          type: "input",
          default: name,
        })
        name = presetValues.name = answer.name
      }

      log.info("")
    }

    if (!type) {
      throw new ParameterError(`Must specify --type if --interactive=false`, {})
    }

    presetValues.kind = "Module"
    presetValues.name = name

    // Throw if module with same name already exists
    if (await pathExists(configPath)) {
      const configs = await loadConfigResources(configDir, configPath)

      if (configs.filter((c) => c.kind === "Module" && c.name === name).length > 0) {
        throw new CreateError(
          chalk.red(
            `A Garden module named ${chalk.white.bold(name)} already exists in ${chalk.white.bold(configPath)}`
          ),
          {
            configDir,
            configPath,
          }
        )
      }
    }

    const definition = allModuleTypes[type]

    if (!definition) {
      throw new ParameterError(`Could not find module type ${chalk.white.bold(type)}`, {
        availableTypes: Object.keys(allModuleTypes),
      })
    }

    const schema = (definition.schema ? baseModuleSpecSchema().concat(definition.schema) : baseModuleSpecSchema()).keys(
      {
        // Hide this from docs until we actually use it
        apiVersion: joi.string().meta({ internal: true }),
      }
    )

    const { yaml } = renderConfigReference(schema, {
      yamlOpts: {
        onEmptyValue: opts["skip-comments"] ? "remove" : "comment out",
        filterMarkdown: true,
        renderBasicDescription: !opts["skip-comments"],
        renderFullDescription: false,
        renderValue: "preferExample",
        presetValues,
      },
    })

    await addConfig(configPath, yaml)

    log.info(chalk.green(`-> Created new module config in ${chalk.bold.white(relative(process.cwd(), configPath))}`))
    log.info("")

    // Warn if module type is defined by provider that isn't configured OR if not in a project, ask to make sure
    // it is configured in the project that will use the module.
    const projectConfig = await findProjectConfig(configDir)
    const pluginName = definition.plugin.name

    if (!fixedPlugins.includes(pluginName)) {
      if (projectConfig) {
        const allProviders = flatten([
          projectConfig.providers,
          ...(projectConfig.environments || []).map((e) => e.providers || []),
        ])

        const allProvidersWithBases = flatten(
          allProviders.map((p) => getPluginBaseNames(p.name, keyBy(getSupportedPlugins, "name")))
        )

        if (!allProvidersWithBases.includes(pluginName)) {
          log.warn(
            chalk.yellow(
              wordWrap(
                deline`
                Module type ${chalk.white.bold(type)} is defined by the ${chalk.white.bold(pluginName)} provider,
                which is not configured in your project. Please make sure it is configured before using the new module.
              `,
                120
              )
            )
          )
          log.info("")
        }
      } else {
        log.info(
          wordWrap(
            deline`
            Module type ${chalk.white.bold(type)} is defined by the ${chalk.white.bold(pluginName)} provider.
            Please make sure it is configured in your project before using the new module.
          `,
            120
          )
        )
        log.info("")
      }
    }

    // This is to avoid `prettier` messing with the string formatting...
    const moduleTypeUrl = chalk.cyan.underline(getModuleTypeUrl(type))
    const providerUrl = chalk.cyan.underline(getProviderUrl(pluginName))
    const configFilesUrl = chalk.cyan.underline(`${DOCS_BASE_URL}/using-garden/configuration-overview`)
    const formattedType = chalk.bold(type)
    const formattedPluginName = chalk.bold(pluginName)

    log.info({
      symbol: "info",
      msg: wordWrap(
        dedent`
        We recommend reviewing the generated config, uncommenting fields that you'd like to configure, and cleaning up any commented fields that you don't need to use.

        For more information about ${formattedType} modules, please check out ${moduleTypeUrl}, and the ${formattedPluginName} provider docs at ${providerUrl}. For general information about Garden configuration files, take a look at ${configFilesUrl}.
        `,
        120
      ),
    })

    log.info("")

    return { result: { configPath, name, type } }
  }
}

export async function getModuleTypeSuggestions(
  log: LogEntry,
  moduleTypes: ModuleTypeMap,
  path: string,
  defaultName: string
) {
  const allSuggestions = flatten(
    await Bluebird.map(Object.values(moduleTypes), async (spec) => {
      if (!spec.handlers.suggestModules) {
        return []
      }

      const { suggestions } = await spec.handlers.suggestModules({ log, name: defaultName, path })
      return suggestions.map((suggestion) => ({ suggestion, pluginName: spec.plugin.name }))
    })
  )

  let choices = Object.keys(moduleTypes).map((moduleType) => ({
    name: moduleType,
    value: { kind: "Module", type: moduleType, name: defaultName },
  }))

  // Note: requiring inquirer inline because it's slow to import
  const inquirer = require("inquirer")

  if (allSuggestions.length > 0) {
    return [
      ...allSuggestions.map((s) => {
        const suggestion = s.suggestion

        let description =
          (suggestion.description ? truncate(suggestion.description, 48) + ", " : "") +
          `suggested by ${chalk.white(s.pluginName)}`

        return {
          name: `${suggestion.module.type} ` + chalk.gray(`(${description})`),
          short: suggestion.module.type,
          value: suggestion.module,
        }
      }),
      new inquirer.Separator(),
      ...choices,
    ]
  } else {
    return choices
  }
}
