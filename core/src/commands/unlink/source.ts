/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import dedent = require("dedent")

import { Command, CommandResult, CommandParams } from "../base"
import { removeLinkedSources } from "../../util/ext-source-util"
import { printHeader } from "../../logger/util"
import { localConfigKeys, LinkedSource } from "../../config-store"
import { StringsParameter, BooleanParameter } from "../../cli/params"

const unlinkSourceArguments = {
  sources: new StringsParameter({
    help: "The name(s) of the source(s) to unlink. Use comma as a separator to specify multiple sources.",
  }),
}

const unlinkSourceOptions = {
  all: new BooleanParameter({
    help: "Unlink all sources.",
    alias: "a",
  }),
}

type Args = typeof unlinkSourceArguments
type Opts = typeof unlinkSourceOptions

export class UnlinkSourceCommand extends Command<Args, Opts> {
  name = "source"
  help = "Unlink a previously linked remote source from its local directory."
  arguments = unlinkSourceArguments
  options = unlinkSourceOptions

  description = dedent`
    After unlinking a remote source, Garden will go back to reading it from its remote URL instead
    of its local directory.

    Examples:

        garden unlink source my-source  # unlinks my-source
        garden unlink source --all      # unlinks all sources
  `

  printHeader({ headerLog }) {
    printHeader(headerLog, "Unlink source", "chains")
  }

  async action({ garden, log, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<LinkedSource[]>> {
    const sourceType = "project"

    const { sources = [] } = args

    if (opts.all) {
      await garden.configStore.set([localConfigKeys().linkedProjectSources], [])
      log.info("Unlinked all sources")
      return { result: [] }
    }

    const linkedProjectSources = await removeLinkedSources({
      garden,
      sourceType,
      names: sources,
    })

    log.info(`Unlinked source(s) ${sources.join(" ")}`)

    return { result: linkedProjectSources }
  }
}
