/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { createGardenPlugin } from "../types/plugin/plugin"

// TODO: remove in 0.13
export const gardenPlugin = () =>
  createGardenPlugin({
    name: "npm-package",
    dependencies: [{ name: "exec" }],
    createModuleTypes: [
      {
        name: "npm-package",
        base: "exec",
        docs: "[DEPRECATED]",
        handlers: {},
      },
    ],
  })
