/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Garden } from "./garden"
import { projectNameSchema, projectSourcesSchema, environmentNameSchema, SourceConfig } from "./config/project"
import { Provider, providerSchema, GenericProviderConfig } from "./config/provider"
import { deline } from "./util/string"
import { joi, joiVariables, joiStringMap, DeepPrimitiveMap } from "./config/common"
import { PluginTool } from "./util/ext-tools"
import { ConfigContext, ContextResolveOpts } from "./config/template-contexts/base"
import { resolveTemplateStrings } from "./template-string/template-string"
import { LogEntry } from "./logger/log-entry"
import { logEntrySchema } from "./types/plugin/base"

type WrappedFromGarden = Pick<
  Garden,
  | "projectName"
  | "projectRoot"
  | "gardenDirPath"
  | "workingCopyId"
  // TODO: remove this from the interface
  | "environmentName"
  | "production"
  | "sessionId"
>

export interface CommandInfo {
  name: string
  args: DeepPrimitiveMap
  opts: DeepPrimitiveMap
}

type ResolveTemplateStringsOpts = Omit<ContextResolveOpts, "stack">

export interface PluginContext<C extends GenericProviderConfig = GenericProviderConfig> extends WrappedFromGarden {
  command: CommandInfo
  log: LogEntry
  projectSources: SourceConfig[]
  provider: Provider<C>
  resolveTemplateStrings: <T>(o: T, opts?: ResolveTemplateStringsOpts) => T
  tools: { [key: string]: PluginTool }
}

// NOTE: this is used more for documentation than validation, outside of internal testing
// TODO: validate the output from createPluginContext against this schema (in tests)
export const pluginContextSchema = () =>
  joi
    .object()
    .options({ presence: "required" })
    .keys({
      command: joi
        .object()
        .optional()
        .keys({
          name: joi.string().required().description("The command name currently being executed."),
          args: joiVariables().required().description("The positional arguments passed to the command."),
          opts: joiVariables().required().description("The optional flags passed to the command."),
        })
        .description("Information about the command being executed, if applicable."),
      environmentName: environmentNameSchema(),
      gardenDirPath: joi.string().description(deline`
        The absolute path of the project's Garden dir. This is the directory the contains builds, logs and
        other meta data. A custom path can be set when initialising the Garden class. Defaults to \`.garden\`.
      `),
      log: logEntrySchema(),
      production: joi
        .boolean()
        .default(false)
        .description("Indicate if the current environment is a production environment.")
        .example(true),
      projectName: projectNameSchema(),
      projectRoot: joi.string().description("The absolute path of the project root."),
      projectSources: projectSourcesSchema(),
      provider: providerSchema().description("The provider being used for this context.").id("ctxProviderSchema"),
      resolveTemplateStrings: joi
        .function()
        .description(
          "Helper function to resolve template strings, given the same templating context as was used to render the configuration before calling the handler. Accepts any data type, and returns the same data type back with all template strings resolved."
        ),
      sessionId: joi.string().description("The unique ID of the currently active session."),
      tools: joiStringMap(joi.object()),
      workingCopyId: joi.string().description("A unique ID assigned to the current project working copy."),
    })

export async function createPluginContext(
  garden: Garden,
  provider: Provider,
  command: CommandInfo,
  templateContext: ConfigContext
): Promise<PluginContext> {
  return {
    command,
    environmentName: garden.environmentName,
    gardenDirPath: garden.gardenDirPath,
    log: garden.log,
    projectName: garden.projectName,
    projectRoot: garden.projectRoot,
    projectSources: garden.getProjectSources(),
    provider,
    production: garden.production,
    resolveTemplateStrings: <T>(o: T, opts?: ResolveTemplateStringsOpts) => {
      return resolveTemplateStrings(o, templateContext, opts || {})
    },
    sessionId: garden.sessionId,
    tools: await garden.getTools(),
    workingCopyId: garden.workingCopyId,
  }
}
