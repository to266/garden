/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import stripAnsi from "strip-ansi"
import { expect } from "chai"
import { omit } from "lodash"
import {
  makeTestGardenA,
  makeTestGardenTasksFails,
  withDefaultGlobalOpts,
  expectError,
  getLogMessages,
} from "../../../../helpers"
import { RunTestCommand } from "../../../../../src/commands/run/test"
import { LogLevel } from "../../../../../src/logger/logger"
import { dedent } from "../../../../../src/util/string"
import { renderDivider } from "../../../../../src/logger/util"

describe("RunTestCommand", () => {
  const cmd = new RunTestCommand()

  it("should run a test", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    const { result } = await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module-a" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": false }),
    })

    expect(cmd.outputsSchema().validate(result).error).to.be.undefined

    expect(result!.result.durationMsec).to.gte(0)
    expect(result!.result.startedAt).to.be.a("Date")
    expect(result!.result.completedAt).to.be.a("Date")
    expect(result!.result.version).to.be.a("string")

    expect(omit(result!.result, ["durationMsec", "startedAt", "completedAt", "version"])).to.eql({
      aborted: false,
      command: ["echo", "OK"],
      moduleName: "module-a",
      log: "OK",
      success: true,
      error: undefined,
      testName: "unit",
    })
  })

  it("should return an error if the test fails", async () => {
    const garden = await makeTestGardenTasksFails()
    const log = garden.log

    const result = await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": true }),
    })

    expect(result.errors).to.have.lengthOf(1)
  })

  it("should throw if the test is disabled", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    await garden.getRawModuleConfigs()
    garden["moduleConfigs"]["module-a"].disabled = true

    await expectError(
      () =>
        cmd.action({
          garden,
          log,
          headerLog: log,
          footerLog: log,
          args: { module: "module-a", test: "unit" },
          opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": false }),
        }),
      (err) =>
        expect(stripAnsi(err.message)).to.equal(
          "Test module-a.unit is disabled for the local environment. If you're sure you want to run it anyway, " +
            "please run the command again with the --force flag."
        )
    )
  })

  it("should allow running a disabled test with the --force flag", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    await garden.scanAndAddConfigs()
    garden["moduleConfigs"]["module-a"].disabled = true

    const { errors } = await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { module: "module-a", test: "unit" },
      opts: withDefaultGlobalOpts({ "force": true, "force-build": false, "interactive": false }),
    })

    expect(errors).to.not.exist
  })

  it("should log the result if interactive=false", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module-a" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": false }),
    })

    const logOutput = getLogMessages(log, (entry) => entry.level === LogLevel.info).join("\n")

    expect(logOutput).to.include(dedent`
    \nTest output:
    ${renderDivider()}
    OK
    ${renderDivider()}

    Done! ✔️
    `)
  })

  it("should not log the result if interactive=true", async () => {
    const garden = await makeTestGardenA()
    const log = garden.log

    await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module-a" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": true }),
    })

    const logOutput = getLogMessages(log, (entry) => entry.level === LogLevel.info).join("\n")
    expect(logOutput).to.not.include("Run test result:")
  })

  it("should log the error if interactive=false", async () => {
    const garden = await makeTestGardenTasksFails()
    const log = garden.log

    await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": false }),
    })

    const logOutput = getLogMessages(log, (entry) => entry.level === LogLevel.error).join("\n")
    expect(logOutput).to.include(dedent`
    \nFailed running unit tests in module module. Here is the output:
    ${renderDivider()}
    test-error
    ${renderDivider()}
    `)
  })

  it("should not log the error if interactive=true", async () => {
    const garden = await makeTestGardenTasksFails()
    const log = garden.log

    await cmd.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { test: "unit", module: "module" },
      opts: withDefaultGlobalOpts({ "force": false, "force-build": false, "interactive": true }),
    })

    const logOutput = getLogMessages(log, (entry) => entry.level === LogLevel.error).join("\n")
    expect(logOutput).to.not.include("test-error")
  })
})
