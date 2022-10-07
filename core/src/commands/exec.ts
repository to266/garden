/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { LoggerType } from "../logger/logger"
import { ExecInServiceResult, execInServiceResultSchema } from "../types/plugin/service/execInService"
import { printHeader } from "../logger/util"
import { Command, CommandResult, CommandParams } from "./base"
import dedent = require("dedent")
import { StringParameter, BooleanParameter, ParameterValues } from "../cli/params"

const execArgs = {
  service: new StringParameter({
    help: "The service to exec the command in.",
    required: true,
  }),
  // TODO: make this variadic
  command: new StringParameter({
    help: "The command to run.",
    required: true,
  }),
}

const execOpts = {
  interactive: new BooleanParameter({
    help: "Set to false to skip interactive mode and just output the command result",
    defaultValue: false,
    cliDefault: true,
    cliOnly: true,
  }),
}

type Args = typeof execArgs
type Opts = typeof execOpts

export class ExecCommand extends Command<Args> {
  name = "exec"
  help = "Executes a command (such as an interactive shell) in a running service."

  description = dedent`
    Finds an active container for a deployed service and executes the given command within the container.
    Supports interactive shells.

    _NOTE: This command may not be supported for all module types._

    Examples:

         garden exec my-service /bin/sh   # runs a shell in the my-service container
  `

  arguments = execArgs
  options = execOpts

  outputsSchema = () => execInServiceResultSchema()

  getLoggerType(): LoggerType {
    return "basic"
  }

  printHeader({ headerLog, args }) {
    const serviceName = args.service
    const command = this.getCommand(args)
    printHeader(
      headerLog,
      `Running command ${chalk.cyan(command.join(" "))} in service ${chalk.cyan(serviceName)}`,
      "runner"
    )
  }

  async action({ garden, log, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<ExecInServiceResult>> {
    const serviceName = args.service
    const command = this.getCommand(args)

    const graph = await garden.getConfigGraph({ log, emit: false })
    const service = graph.getService(serviceName)
    const actions = await garden.getActionRouter()
    const result = await actions.execInService({
      log,
      graph,
      service,
      command,
      interactive: opts.interactive,
    })

    return { result }
  }

  private getCommand(args: ParameterValues<Args>) {
    return args.command.split(" ") || []
  }
}
