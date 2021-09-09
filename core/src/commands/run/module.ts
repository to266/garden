/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"

import { printHeader } from "../../logger/util"
import { prepareRuntimeContext } from "../../runtime-context"
import { BuildTask } from "../../tasks/build"
import { RunResult } from "../../types/plugin/base"
import { dedent, deline } from "../../util/string"
import { Command, CommandParams, CommandResult, handleRunResult, ProcessResultMetadata } from "../base"
import { printRuntimeContext } from "./run"
import { GraphResults } from "../../task-graph"
import { StringParameter, StringsParameter, BooleanParameter, StringOption } from "../../cli/params"

const runModuleArgs = {
  module: new StringParameter({
    help: "The name of the module to run.",
    required: true,
  }),
  // TODO: make this a variadic arg
  arguments: new StringsParameter({
    help: "The arguments to run the module with. Example: 'yarn run my-script'.",
    delimiter: " ",
  }),
}

const runModuleOpts = {
  // TODO: we could provide specific parameters like this by adding commands for specific modules, via plugins
  //entrypoint: new StringParameter({ help: "Override default entrypoint in module" }),
  "interactive": new BooleanParameter({
    help: "Set to false to skip interactive mode and just output the command result.",
    defaultValue: false,
    cliDefault: true,
    cliOnly: true,
  }),
  "force-build": new BooleanParameter({
    help: "Force rebuild of module before running.",
  }),
  "command": new StringOption({
    help: deline`The base command (a.k.a. entrypoint) to run in the module. For container modules, for example,
      this overrides the image's default command/entrypoint. This option may not be relevant for all module types.
      Example: '/bin/sh -c'.`,
    alias: "c",
  }),
}

type Args = typeof runModuleArgs
type Opts = typeof runModuleOpts

interface RunModuleOutput {
  result: RunResult & ProcessResultMetadata
  graphResults: GraphResults
}

export class RunModuleCommand extends Command<Args, Opts> {
  name = "module"
  help = "Run an ad-hoc instance of a module."

  description = dedent`
    This is useful for debugging or ad-hoc experimentation with modules.

    Examples:

        garden run module my-container                                   # run an ad-hoc instance of a my-container \
         container and attach to it
        garden run module my-container /bin/sh                           # run an interactive shell in a new \
         my-container container
        garden run module my-container --interactive=false /some/script  # execute a script in my-container and \
         return the output
  `

  arguments = runModuleArgs
  options = runModuleOpts

  printHeader({ headerLog, args }) {
    const moduleName = args.module
    const msg = args.arguments
      ? `Running module ${chalk.white(moduleName)} with arguments ${chalk.white(args.arguments.join(" "))}`
      : `Running module ${chalk.white(moduleName)}`

    printHeader(headerLog, msg, "runner")
  }

  async action({ garden, log, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<RunModuleOutput>> {
    const moduleName = args.module

    const graph = await garden.getConfigGraph({ log, emit: false })
    const module = graph.getModule(moduleName)

    const actions = await garden.getActionRouter()

    const buildTasks = await BuildTask.factory({
      garden,
      graph,
      log,
      module,
      force: opts["force-build"],
    })
    const graphResults = await garden.processTasks(buildTasks)

    const dependencies = graph.getDependencies({ nodeType: "build", name: module.name, recursive: false })
    const interactive = opts.interactive

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      dependencies,
      version: module.version.versionString,
      moduleVersion: module.version.versionString,
      serviceStatuses: {},
      taskResults: {},
    })

    printRuntimeContext(log, runtimeContext)

    log.info("")

    if (interactive) {
      log.root.stop()
    }

    const result = await actions.runModule({
      log,
      graph,
      module,
      command: opts.command?.split(" "),
      args: args.arguments || [],
      runtimeContext,
      interactive,
      timeout: interactive ? 999999 : undefined,
    })

    return handleRunResult({ log, actionDescription: "run module", result, interactive, graphResults })
  }
}
