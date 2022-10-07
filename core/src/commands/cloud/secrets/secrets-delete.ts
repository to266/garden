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

export const secretsDeleteArgs = {
  ids: new StringsParameter({
    help: deline`The IDs of the secrets to delete.`,
  }),
}

type Args = typeof secretsDeleteArgs

export class SecretsDeleteCommand extends Command<Args> {
  name = "delete"
  help = "Delete secrets."
  description = dedent`
    Delete secrets in Garden Cloud. You will nee the IDs of the secrets you want to delete,
    which you which you can get from the \`garden cloud secrets list\` command.

    Examples:
        garden cloud secrets delete 1,2,3   # delete secrets with IDs 1,2, and 3.
  `

  arguments = secretsDeleteArgs

  printHeader({ headerLog }) {
    printHeader(headerLog, "Delete secrets", "lock")
  }

  async action({ garden, args, log, opts }: CommandParams<Args>): Promise<CommandResult<DeleteResult[]>> {
    const secretsToDelete = (args.ids || []).map((id) => parseInt(id, 10))
    if (secretsToDelete.length === 0) {
      throw new CommandError(`No secret IDs provided.`, {
        args,
      })
    }

    if (!opts.yes && !(await confirmDelete("secret", secretsToDelete.length))) {
      return {}
    }

    const api = garden.cloudApi
    if (!api) {
      throw new ConfigurationError(noApiMsg("delete", "secrets"), {})
    }

    const cmdLog = log.info({ status: "active", section: "secrets-command", msg: "Deleting secrets..." })

    let count = 1
    const errors: ApiCommandError[] = []
    const results: DeleteResult[] = []
    for (const id of secretsToDelete) {
      cmdLog.setState({ msg: `Deleting secrets... → ${count}/${secretsToDelete.length}` })
      count++
      try {
        const res = await api.delete<BaseResponse>(`/secrets/${id}`)
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
      resource: "secret",
      results,
    })
  }
}
