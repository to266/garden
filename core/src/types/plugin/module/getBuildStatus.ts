/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { dedent } from "../../../util/string"
import { GardenModule } from "../../module"
import { PluginModuleActionParamsBase, moduleActionParamsSchema } from "../base"
import { joi } from "../../../config/common"

export interface GetBuildStatusParams<T extends GardenModule = GardenModule> extends PluginModuleActionParamsBase<T> {}

export interface BuildStatus {
  ready: boolean
  detail?: any
}

export const getBuildStatus = () => ({
  description: dedent`
    Check and return the build status of a module, i.e. whether the current version been built.

    Called before running the \`build\` action, which is not run if this returns \`{ ready: true }\`.
  `,
  paramsSchema: moduleActionParamsSchema(),
  resultSchema: joi.object().keys({
    ready: joi.boolean().required().description("Whether an up-to-date build is ready for the module."),
    detail: joi.any().description("Optional provider-specific information about the build."),
  }),
})
