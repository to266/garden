/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { PluginActionParamsBase, actionParamsSchema } from "../base"
import { dedent } from "../../../util/string"
import { joi, joiArray, joiIdentifier, joiIdentifierMap } from "../../../config/common"
import { baseModuleSpecSchema, AddModuleSpec } from "../../../config/module"
import { providerSchema, ProviderMap } from "../../../config/provider"
import { GardenModule, moduleSchema } from "../../module"

export interface AugmentGraphParams extends PluginActionParamsBase {
  modules: GardenModule[]
  providers: ProviderMap
}

interface AddDependency {
  by: string
  on: string
}

export interface AugmentGraphResult {
  addRuntimeDependencies?: AddDependency[]
  addModules?: AddModuleSpec[]
}

export const addModuleSchema = () => baseModuleSpecSchema()

export const augmentGraph = () => ({
  description: dedent`
    Add modules and/or dependency relationships to the project stack graph. See the individual output fields for
    details.

    The handler receives all configured providers and their configs, as well as all previously defined modules
    in the project, including all modules added by any \`augmentGraph\` handlers defined by other providers
    that this provider depends on. Which is to say, all the \`augmentGraph\` handlers are called and their outputs
    applied in dependency order.

    Note that this handler is called frequently when resolving module configuration, so it should return quickly
    and avoid any external I/O.
  `,
  paramsSchema: actionParamsSchema().keys({
    modules: joiArray(moduleSchema()).description(
      dedent`
          A list of all previously defined modules in the project, including all modules added by any \`augmentGraph\`
          handlers defined by other providers that this provider depends on.
        `
    ),
    providers: joiIdentifierMap(providerSchema()).description("Map of all configured providers in the project."),
  }),
  resultSchema: joi.object().keys({
    addRuntimeDependencies: joi
      .array()
      .items(
        joi
          .object()
          .optional()
          .keys({
            by: joiIdentifier().description(
              "The _dependant_, i.e. the service or task that should have a runtime dependency on `on`."
            ),
            on: joiIdentifier().description("The _dependency, i.e. the service or task that `by` should depend on."),
          })
      )
      .description(
        dedent`
        Add runtime dependencies between two services or tasks, where \`by\` depends on \`on\`.

        Both services/tasks must be previously defined in the project, added by one of the providers that this provider
        depends on, _or_ it can be defined in one of the modules specified in \`addModules\`.

        The most common use case for this field is to make an existing service or task depend on one of the
        services/tasks specified under \`addModules\`.
      `
      ),
    addModules: joi
      .array()
      .items(addModuleSchema().optional())
      .description(
        dedent`
          Add modules (of any defined kind) to the stack graph. Each should be a module spec in the same format as
          a normal module specified in a \`garden.yml\` config file (which will later be passed to the appropriate
          \`configure\` handler(s) for the module type).

          Added services/tasks can be referenced in \`addRuntimeDependencies\`.
        `
      ),
  }),
})
