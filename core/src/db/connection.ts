/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { join } from "path"
import type { Connection, ConnectionOptions } from "typeorm-with-better-sqlite3"
import { gardenEnv } from "../constants"
import { profileAsync } from "../util/profiling"

let connection: Connection

const connectionName = "default"
const databasePath = join(gardenEnv.GARDEN_DB_DIR, "db")

// Note: This function needs to be synchronous to work with the typeorm Active Record pattern (see ./base-entity.ts)
export function getConnection(): Connection {
  // Note: lazy-loading for startup performance
  const { getConnectionManager } = require("typeorm-with-better-sqlite3")

  if (!connection && getConnectionManager().has(connectionName)) {
    connection = getConnectionManager().get(connectionName)
  }

  if (!connection) {
    const { LocalAddress } = require("./entities/local-address")
    const { ClientAuthToken } = require("./entities/client-auth-token")
    const { GardenProcess } = require("./entities/garden-process")
    const { Warning } = require("./entities/warning")
    const { Init1599658427984 } = require("./migrations/1599658427984-Init")
    const { refreshAuthToken1605039158093 } = require("./migrations/1605039158093-refresh-auth-token")

    // Prepare the connection (the ormconfig.json in the static dir is only used for the typeorm CLI during dev)
    const options: ConnectionOptions = {
      name: connectionName,
      type: "better-sqlite3",
      database: databasePath,
      // IMPORTANT: All entities and migrations need to be manually referenced here because of how we
      // package the garden binary
      entities: [LocalAddress, ClientAuthToken, GardenProcess, Warning],
      migrations: [Init1599658427984, refreshAuthToken1605039158093],
      // Auto-run migrations on init
      migrationsRun: true,
    }
    connection = getConnectionManager().create(options)
  }

  return connection
}

export const ensureConnected = profileAsync(async function _ensureConnected() {
  const _connection = getConnection()
  if (!_connection.isConnected) {
    await _connection.connect()
  }
})
