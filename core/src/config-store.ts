/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import yaml from "js-yaml"
import { join } from "path"
import { ensureFile, readFile } from "fs-extra"
import { get, isPlainObject, unset, mapValues } from "lodash"

import { Primitive, joiArray, joiPrimitive, joi } from "./config/common"
import { validateSchema } from "./config/validation"
import { LocalConfigError } from "./exceptions"
import { dumpYaml } from "./util/util"
import { LOCAL_CONFIG_FILENAME, GLOBAL_CONFIG_FILENAME, GARDEN_GLOBAL_PATH } from "./constants"
import { linkedSourceSchema } from "./config/project"

export type ConfigValue = Primitive | Primitive[] | Object[] | Object

export type SetManyParam = { keyPath: Array<string>; value: ConfigValue }[]

export abstract class ConfigStore<T extends object = any> {
  private config: null | T
  protected configPath: string

  constructor(gardenDirPath: string) {
    this.configPath = this.getConfigPath(gardenDirPath)
    this.config = null
  }

  abstract getConfigPath(gardenDirPath: string): string
  abstract validate(config): T

  /**
   * Would've been nice to allow something like: set(["path", "to", "valA", valA], ["path", "to", "valB", valB]...)
   * but Typescript support is missing at the moment
   */
  public async set(param: SetManyParam): Promise<void>
  public async set(keyPath: string[], value: ConfigValue): Promise<void>
  public async set(...args): Promise<void> {
    let config = await this.getConfig()
    let entries: SetManyParam

    if (args.length === 1) {
      entries = args[0]
    } else {
      entries = [{ keyPath: args[0], value: args[1] }]
    }

    for (const { keyPath, value } of entries) {
      config = await this.updateConfig(config, keyPath, value)
    }

    await this.saveConfig(config)
  }

  public async get(): Promise<T>
  public async get(keyPath: string[]): Promise<Object | ConfigValue>
  public async get(keyPath?: string[]): Promise<Object | ConfigValue> {
    const config = await this.getConfig()

    if (keyPath) {
      const value = get(config, keyPath)

      if (value === undefined) {
        this.throwKeyNotFound(config, keyPath)
      }

      return value
    }

    return config
  }

  public async clear() {
    await this.saveConfig(<T>{})
  }

  public async delete(keyPath: string[]) {
    let config = await this.getConfig()
    if (get(config, keyPath) === undefined) {
      this.throwKeyNotFound(config, keyPath)
    }
    const success = unset(config, keyPath)
    if (!success) {
      throw new LocalConfigError(`Unable to delete key ${keyPath.join(".")} in user config`, {
        keyPath,
        config,
      })
    }
    await this.saveConfig(config)
  }

  private async getConfig(): Promise<T> {
    if (!this.config) {
      await this.loadConfig()
    }
    // Spreading does not work on generic types, see: https://github.com/Microsoft/TypeScript/issues/13557
    return <T>Object.assign(<T>this.config, {})
  }

  private updateConfig(config: T, keyPath: string[], value: ConfigValue): T {
    let currentValue = config

    for (let i = 0; i < keyPath.length; i++) {
      const k = keyPath[i]

      if (i === keyPath.length - 1) {
        currentValue[k] = value
      } else if (currentValue[k] === undefined) {
        currentValue[k] = {}
      } else if (!isPlainObject(currentValue[k])) {
        const path = keyPath.slice(i + 1).join(".")

        throw new LocalConfigError(
          `Attempting to assign a nested key on non-object (current value at ${path}: ${currentValue[k]})`,
          {
            currentValue: currentValue[k],
            path,
          }
        )
      }

      currentValue = currentValue[k]
    }
    return config
  }

  private async ensureConfigFile() {
    await ensureFile(this.configPath)
  }

  private async loadConfig() {
    await this.ensureConfigFile()
    const config = yaml.safeLoad((await readFile(this.configPath)).toString()) || {}

    this.config = this.validate(config)
  }

  private async saveConfig(config: T) {
    this.config = null
    const validated = this.validate(config)
    await dumpYaml(this.configPath, validated)
    this.config = validated
  }

  private throwKeyNotFound(config: T, keyPath: string[]) {
    throw new LocalConfigError(`Could not find key ${keyPath.join(".")} in user config`, {
      keyPath,
      config,
    })
  }
}

/*********************************************
 *                                           *
 *  LocalConfigStore implementation          *
 *                                           *
 **********************************************/

export interface LinkedSource {
  name: string
  path: string
}

export interface AnalyticsLocalConfig {
  projectId: string
}

export interface LocalConfig {
  linkedModuleSources?: LinkedSource[] // TODO Use KeyedSet instead of array
  linkedProjectSources?: LinkedSource[]
  analytics: AnalyticsLocalConfig
}

const analyticsLocalConfigSchema = () =>
  joi
    .object()
    .keys({
      projectId: joi.string(),
    })
    .meta({ internal: true })

const localConfigSchemaKeys = {
  linkedModuleSources: () => joiArray(linkedSourceSchema()),
  linkedProjectSources: () => joiArray(linkedSourceSchema()),
  analytics: () => analyticsLocalConfigSchema(),
}

export const localConfigKeys = () =>
  Object.keys(localConfigSchemaKeys).reduce((acc, key) => {
    acc[key] = key
    return acc
  }, {}) as { [K in keyof typeof localConfigSchemaKeys]: K }

const localConfigSchema = () =>
  joi
    .object()
    .keys(mapValues(localConfigSchemaKeys, (schema) => schema()))
    .meta({ internal: true })

// TODO: we should not be passing this to provider actions
export const configStoreSchema = () =>
  joi.object().description("Helper class for managing local configuration for plugins.")

export class LocalConfigStore extends ConfigStore<LocalConfig> {
  getConfigPath(gardenDirPath: string): string {
    return join(gardenDirPath, LOCAL_CONFIG_FILENAME)
  }

  validate(config): LocalConfig {
    return validateSchema(config, localConfigSchema(), {
      context: this.configPath,
      ErrorClass: LocalConfigError,
    })
  }
}

/*********************************************
 *                                           *
 *  GlobalConfigStore implementation         *
 *                                           *
 **********************************************/

export type AnalyticsGlobalConfig = {
  userId?: string
  optedIn?: boolean
  firstRun?: boolean
  showOptInMessage?: boolean
  cloudVersion?: number
  cloudProfileEnabled?: boolean
} & {
  [key: string]: any
}

export interface VersionCheckGlobalConfig {
  lastRun: Date
}

export interface RequirementsCheck {
  lastRunDateUNIX?: number
  lastRunGardenVersion?: string
  passed?: boolean
}

export interface GlobalConfig {
  analytics?: AnalyticsGlobalConfig
  lastVersionCheck?: VersionCheckGlobalConfig
}

const analyticsGlobalConfigSchema = () =>
  joi
    .object()
    .keys({
      userId: joiPrimitive().allow("").optional(),
      optedIn: joi.boolean().optional(),
      firstRun: joi.boolean().optional(),
      showOptInMessage: joi.boolean().optional(),
      cloudVersion: joi.number().optional(),
      cloudProfileEnabled: joi.boolean().optional(),
    })
    .unknown(true)
    .meta({ internal: true })

const versionCheckGlobalConfigSchema = () =>
  joi
    .object()
    .keys({
      lastRun: joi.date().optional(),
    })
    .unknown(true)
    .meta({ internal: true })

const requirementsCheckGlobalConfigSchema = () =>
  joi
    .object()
    .keys({
      lastRunDateUNIX: joi.number().optional(),
      lastRunGardenVersion: joi.string().optional(),
      passed: joi.bool().optional(),
    })
    .unknown(true)
    .meta({ internal: true })

const globalConfigSchemaKeys = {
  analytics: analyticsGlobalConfigSchema(),
  lastVersionCheck: versionCheckGlobalConfigSchema(),
  requirementsCheck: requirementsCheckGlobalConfigSchema(),
}

/* This contains a config key, key string pair to be used when setting/getting values in the store
 eg.
  globalConfigKeys = {
    analytics: "analytics"
  }

  used like:
  globalConfigStore.set([globalConfigKeys.analytics], { data: value })
*/
export const globalConfigKeys = Object.keys(globalConfigSchemaKeys).reduce((acc, key) => {
  acc[key] = key
  return acc
}, {}) as { [K in keyof typeof globalConfigSchemaKeys]: K }

const globalConfigSchema = () => joi.object().keys(globalConfigSchemaKeys).unknown(true).meta({ internal: true })

export class GlobalConfigStore extends ConfigStore<GlobalConfig> {
  constructor() {
    super(GARDEN_GLOBAL_PATH)
  }

  getConfigPath(): string {
    return join(GARDEN_GLOBAL_PATH, GLOBAL_CONFIG_FILENAME)
  }

  validate(config): GlobalConfig {
    return validateSchema(config, globalConfigSchema(), {
      context: this.configPath,
      ErrorClass: LocalConfigError,
    })
  }
}
