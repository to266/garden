/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { BaseResponse } from "@garden-io/platform-api-types"
import { StringsParameter } from "../../../cli/params"
import { CommandError, ConfigurationError } from "../../../exceptions"
import { printHeader } from "../../../logger/util"
import { dedent, deline } from "../../../util/string"
import { Command, CommandParams, CommandResult } from "../../base"
import { ApiCommandError, confirmDelete, DeleteResult, handleBulkOperationResult, noApiMsg } from "../helpers"

export const usersDeleteArgs = {
  ids: new StringsParameter({
    help: deline`The IDs of the users to delete.`,
  }),
}

type Args = typeof usersDeleteArgs

export class UsersDeleteCommand extends Command<Args> {
  name = "delete"
  help = "Delete users."
  description = dedent`
    Delete users in Garden Cloud. You will nee the IDs of the users you want to delete,
    which you which you can get from the \`garden cloud users list\` command.

    Examples:
        garden cloud users delete 1,2,3   # delete users with IDs 1,2, and 3.
  `

  arguments = usersDeleteArgs

  printHeader({ headerLog }) {
    printHeader(headerLog, "Delete users", "lock")
  }

  async action({ garden, args, log, opts }: CommandParams<Args>): Promise<CommandResult<DeleteResult[]>> {
    const usersToDelete = (args.ids || []).map((id) => parseInt(id, 10))
    if (usersToDelete.length === 0) {
      throw new CommandError(`No user IDs provided.`, {
        args,
      })
    }

    if (!opts.yes && !(await confirmDelete("user", usersToDelete.length))) {
      return {}
    }

    const api = garden.cloudApi
    if (!api) {
      throw new ConfigurationError(noApiMsg("delete", "user"), {})
    }

    const cmdLog = log.info({ status: "active", section: "users-command", msg: "Deleting users..." })

    let count = 1
    const errors: ApiCommandError[] = []
    const results: DeleteResult[] = []
    for (const id of usersToDelete) {
      cmdLog.setState({ msg: `Deleting users... → ${count}/${usersToDelete.length}` })
      count++
      try {
        const res = await api.delete<BaseResponse>(`/users/${id}`)
        results.push({ id, status: res.status })
      } catch (err) {
        errors.push({
          identifier: id,
          message: err?.response?.body?.message || err.messsage,
        })
      }
    }

    return handleBulkOperationResult({
      log,
      cmdLog,
      errors,
      action: "delete",
      resource: "user",
      results,
    })
  }
}
