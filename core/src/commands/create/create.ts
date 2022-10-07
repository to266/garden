/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { CommandGroup } from "../base"
import { CreateProjectCommand } from "./create-project"
import { CreateModuleCommand } from "./create-module"

export class CreateCommand extends CommandGroup {
  name = "create"
  help = "Create new project or module."

  subCommands = [CreateProjectCommand, CreateModuleCommand]
}
