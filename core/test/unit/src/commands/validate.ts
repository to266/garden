/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { join } from "path"
import { ValidateCommand } from "../../../../src/commands/validate"
import { expectError, withDefaultGlobalOpts, dataDir, makeTestGardenA, makeTestGarden } from "../../../helpers"

describe("commands.validate", () => {
  it(`should successfully validate a test project`, async () => {
    const garden = await makeTestGardenA()
    const log = garden.log
    const command = new ValidateCommand()

    await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {},
      opts: withDefaultGlobalOpts({}),
    })
  })

  it("should fail validating the bad-project project", async () => {
    const root = join(dataDir, "validate", "bad-project")

    await expectError(async () => await makeTestGarden(root, { noTempDir: true, noCache: true }), "configuration")
  })

  it("should fail validating the bad-module project", async () => {
    const root = join(dataDir, "validate", "bad-module")
    const garden = await makeTestGarden(root)
    const log = garden.log
    const command = new ValidateCommand()

    await expectError(
      async () =>
        await command.action({
          garden,
          log,
          headerLog: log,
          footerLog: log,
          args: {},
          opts: withDefaultGlobalOpts({}),
        }),
      "configuration"
    )
  })

  it("should fail validating the bad-workflow project", async () => {
    const root = join(dataDir, "validate", "bad-workflow")
    const garden = await makeTestGarden(root, { noTempDir: true, noCache: true })
    const log = garden.log
    const command = new ValidateCommand()

    await expectError(
      async () =>
        await command.action({
          garden,
          log,
          headerLog: log,
          footerLog: log,
          args: {},
          opts: withDefaultGlobalOpts({}),
        }),
      "configuration"
    )
  })
})
