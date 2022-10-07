/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { CommandGroup } from "../base"
import { LinkSourceCommand } from "./source"
import { LinkModuleCommand } from "./module"

export class LinkCommand extends CommandGroup {
  name = "link"
  help = "Link a remote source or module to a local path."

  subCommands = [LinkSourceCommand, LinkModuleCommand]
}
