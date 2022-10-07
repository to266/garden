/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { namespaceStatusesSchema } from "../types/plugin/base"
import { joi, joiVariables } from "./common"

export const environmentStatusSchema = () =>
  joi
    .object()
    .keys({
      ready: joi.boolean().required().description("Set to true if the environment is fully configured for a provider."),
      detail: joi
        .object()
        .optional()
        .meta({ extendable: true })
        .description("Use this to include additional information that is specific to the provider."),
      namespaceStatuses: namespaceStatusesSchema().optional(),
      outputs: joiVariables()
        .meta({ extendable: true })
        .description("Output variables that modules and other variables can reference."),
      disableCache: joi.boolean().optional().description("Set to true to disable caching of the status."),
      cached: joi
        .boolean()
        .optional()
        .meta({ internal: true })
        .description("Indicates if the status was retrieved from cache by the framework."),
    })
    .description("Description of an environment's status for a provider.")
