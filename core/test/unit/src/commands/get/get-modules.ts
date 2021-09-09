/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { keyBy, omit, mapValues } from "lodash"
import { makeTestGardenA, withDefaultGlobalOpts } from "../../../../helpers"
import { GetModulesCommand } from "../../../../../src/commands/get/get-modules"

describe("GetModulesCommand", () => {
  const command = new GetModulesCommand()

  it("returns all modules in a project", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { modules: undefined },
      opts: withDefaultGlobalOpts({ "exclude-disabled": false }),
    })

    expect(command.outputsSchema().validate(res.result).error).to.be.undefined

    const expected = mapValues(keyBy(await garden.resolveModules({ log }), "name"), (m) => omit(m, ["_config"]))

    expect(res.result).to.eql({ modules: expected })
  })

  it("skips disabled modules if exclude-disabled=true", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    await garden.scanAndAddConfigs()
    garden["moduleConfigs"]["module-a"].disabled = true

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { modules: undefined },
      opts: withDefaultGlobalOpts({ "exclude-disabled": true }),
    })

    expect(command.outputsSchema().validate(res.result).error).to.be.undefined

    expect(res.result?.modules["module-a"]).to.not.exist
    expect(res.result?.modules["module-b"]).to.exist
  })

  it("returns specified module in a project", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { modules: ["module-a"] },
      opts: withDefaultGlobalOpts({ "exclude-disabled": false }),
    })

    expect(command.outputsSchema().validate(res.result).error).to.be.undefined

    const graph = await garden.getConfigGraph({ log, emit: false })
    const moduleA = graph.getModule("module-a")

    expect(res.result).to.eql({ modules: { "module-a": omit(moduleA, ["_config"]) } })
  })
})
