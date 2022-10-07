/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { DEFAULT_API_VERSION } from "../../../../src/constants"
import { expectError, TestGarden, getDataDir, makeTestGarden } from "../../../helpers"
import stripAnsi from "strip-ansi"
import {
  ModuleTemplateResource,
  resolveModuleTemplate,
  ModuleTemplateConfig,
  resolveTemplatedModule,
} from "../../../../src/config/module-template"
import { resolve } from "path"
import { joi } from "../../../../src/config/common"
import { pathExists, remove } from "fs-extra"
import { TemplatedModuleConfig } from "../../../../src/plugins/templated"
import { cloneDeep } from "lodash"

describe("module templates", () => {
  let garden: TestGarden

  before(async () => {
    garden = await makeTestGarden(getDataDir("test-projects", "module-templates"))
  })

  describe("resolveModuleTemplate", () => {
    let defaults: any

    before(() => {
      defaults = {
        apiVersion: DEFAULT_API_VERSION,
        kind: "ModuleTemplate",
        name: "test",
        path: garden.projectRoot,
        configPath: resolve(garden.projectRoot, "templates.garden.yml"),
      }
    })

    it("resolves template strings for fields other than modules and files", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
        inputsSchemaPath: "${project.name}.json",
      }
      const resolved = await resolveModuleTemplate(garden, config)
      expect(resolved.inputsSchemaPath).to.eql("module-templates.json")
    })

    it("ignores template strings in modules", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
        modules: [
          {
            type: "test",
            name: "${inputs.foo}",
          },
        ],
      }
      const resolved = await resolveModuleTemplate(garden, config)
      expect(resolved.modules).to.eql(config.modules)
    })

    it("throws on an invalid schema", async () => {
      const config: any = {
        ...defaults,
        foo: "bar",
      }
      await expectError(
        () => resolveModuleTemplate(garden, config),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            'Error validating ModuleTemplate (templates.garden.yml): key "foo" is not allowed at path [foo]'
          )
      )
    })

    it("defaults to an empty object schema for inputs", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
      }
      const resolved = await resolveModuleTemplate(garden, config)
      expect((<any>resolved.inputsSchema)._rules[0].args.jsonSchema.schema).to.eql({
        type: "object",
        additionalProperties: false,
      })
    })

    it("parses a valid JSON inputs schema", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
        inputsSchemaPath: "module-templates.json",
      }
      const resolved = await resolveModuleTemplate(garden, config)
      expect(resolved.inputsSchema).to.exist
    })

    it("throws if inputs schema cannot be found", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
        inputsSchemaPath: "foo.json",
      }
      const path = resolve(config.path, config.inputsSchemaPath!)
      await expectError(
        () => resolveModuleTemplate(garden, config),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            `Unable to read inputs schema for ModuleTemplate test: Error: ENOENT: no such file or directory, open '${path}'`
          )
      )
    })

    it("throws if an invalid JSON schema is provided", async () => {
      const config: ModuleTemplateResource = {
        ...defaults,
        inputsSchemaPath: "invalid.json",
      }
      await expectError(
        () => resolveModuleTemplate(garden, config),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            `Inputs schema for ModuleTemplate test has type string, but should be "object".`
          )
      )
    })
  })

  describe("resolveTemplatedModule", () => {
    let template: ModuleTemplateConfig
    let defaults: TemplatedModuleConfig

    const templates: { [name: string]: ModuleTemplateConfig } = {}

    before(() => {
      template = {
        apiVersion: DEFAULT_API_VERSION,
        kind: "ModuleTemplate",
        name: "test",
        path: garden.projectRoot,
        configPath: resolve(garden.projectRoot, "modules.garden.yml"),
        inputsSchema: joi.object().keys({
          foo: joi.string(),
        }),
        modules: [],
      }
      templates.test = template

      defaults = {
        apiVersion: DEFAULT_API_VERSION,
        kind: "Module",
        name: "test",
        type: "templated",
        path: garden.projectRoot,
        configPath: resolve(garden.projectRoot, "modules.garden.yml"),
        spec: {
          template: "test",
        },
        allowPublish: false,
        build: { dependencies: [] },
        disabled: false,
        modules: [],
        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }
    })

    it("resolves template strings on the templated module config", async () => {
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "${project.name}",
          },
        },
      }
      const { resolvedSpec } = await resolveTemplatedModule(garden, config, templates)
      expect(resolvedSpec.inputs?.foo).to.equal("module-templates")
    })

    it("resolves all parent, template and input template strings, ignoring others", async () => {
      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "${parent.name}-${template.name}-${inputs.foo}",
              build: {
                dependencies: [{ name: "${parent.name}-${template.name}-foo", copy: [] }],
              },
              image: "${modules.foo.outputs.bar || inputs.foo}",
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "bar",
          },
        },
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)
      const module = resolved.modules[0]

      expect(module.name).to.equal("test-test-bar")
      expect(module.build.dependencies).to.eql([{ name: "test-test-foo", copy: [] }])
      expect(module.spec.image).to.equal("${modules.foo.outputs.bar || inputs.foo}")
    })

    it("throws if module is invalid", async () => {
      const config: any = {
        ...defaults,
        spec: {
          ...defaults.spec,
          foo: "bar",
        },
      }
      await expectError(
        () => resolveTemplatedModule(garden, config, templates),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            'Error validating templated module test (modules.garden.yml): key "foo" is not allowed at path [foo]'
          )
      )
    })

    it("throws if template cannot be found", async () => {
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: { ...defaults.spec, template: "foo" },
      }
      await expectError(
        () => resolveTemplatedModule(garden, config, templates),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            "Templated module test references template foo, which cannot be found. Available templates: test"
          )
      )
    })

    it("fully resolves the source path on module files", async () => {
      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "foo",
              generateFiles: [{ sourcePath: "foo/bar.txt", targetPath: "foo.txt", resolveTemplates: true }],
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "bar",
          },
        },
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      const absPath = resolve(config.path, "foo", "bar.txt")
      expect(resolved.modules[0].generateFiles![0].sourcePath).to.equal(absPath)
    })

    it("creates the module path directory, if necessary", async () => {
      const absPath = resolve(garden.projectRoot, ".garden", "foo")
      await remove(absPath)

      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "foo",
              path: `.garden/foo`,
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "bar",
          },
        },
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)
      const module = resolved.modules[0]

      expect(module.path).to.equal(absPath)
      expect(await pathExists(module.path)).to.be.true
    })

    it("attaches parent module and template metadata to the output modules", async () => {
      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "foo",
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "bar",
          },
        },
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      expect(resolved.modules[0].parentName).to.equal(config.name)
      expect(resolved.modules[0].templateName).to.equal(template.name)
      expect(resolved.modules[0].inputs).to.eql(config.spec.inputs)
    })

    it("resolves template strings in template module names", async () => {
      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "${inputs.foo}",
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        spec: {
          ...defaults.spec,
          inputs: {
            foo: "bar",
          },
        },
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      expect(resolved.modules[0].name).to.equal("bar")
    })

    it("returns no modules if templated module is disabled", async () => {
      const _templates = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "foo",
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
        disabled: true,
      }

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      expect(resolved.modules.length).to.equal(0)
    })

    it("throws if an invalid module spec is in the template", async () => {
      const _templates: any = {
        test: {
          ...template,
          modules: [
            {
              type: 123,
              name: "foo",
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
      }
      await expectError(
        () => resolveTemplatedModule(garden, config, _templates),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            "ModuleTemplate test returned an invalid module (named foo) for templated module test: Error validating module (modules.garden.yml): key .type must be a string"
          )
      )
    })

    it("throws if a module spec has an invalid name", async () => {
      const _templates: any = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: 123,
            },
          ],
        },
      }
      const config: TemplatedModuleConfig = {
        ...defaults,
      }
      await expectError(
        () => resolveTemplatedModule(garden, config, _templates),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            "ModuleTemplate test returned an invalid module (named 123) for templated module test: Error validating module (modules.garden.yml): key .name must be a string"
          )
      )
    })

    it("resolves project variable references in input fields", async () => {
      const _templates: any = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "${inputs.name}-test",
            },
          ],
        },
      }

      const config: TemplatedModuleConfig = cloneDeep(defaults)
      config.spec.inputs = { name: "${var.test}" }
      garden.variables.test = "test-value"

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      expect(resolved.modules[0].name).to.equal("test-value-test")
    })

    it("passes through unresolvable template strings in inputs field", async () => {
      const _templates: any = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "test",
            },
          ],
        },
      }

      const templateString = "version-${modules.foo.version}"

      const config: TemplatedModuleConfig = cloneDeep(defaults)
      config.spec.inputs = { version: templateString }

      const resolved = await resolveTemplatedModule(garden, config, _templates)

      expect(resolved.modules[0].inputs?.version).to.equal(templateString)
    })

    it("throws if an unresolvable template string is used for a templated module name", async () => {
      const _templates: any = {
        test: {
          ...template,
          modules: [
            {
              type: "test",
              name: "${inputs.name}-test",
            },
          ],
        },
      }

      const config: TemplatedModuleConfig = cloneDeep(defaults)
      config.spec.inputs = { name: "module-${modules.foo.version}" }

      await expectError(
        () => resolveTemplatedModule(garden, config, _templates),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            'ModuleTemplate test returned an invalid module (named module-${modules.foo.version}-test) for templated module test: Error validating module (modules.garden.yml): key .name with value "module-${modules.foo.version}-test" fails to match the required pattern: /^(?!garden)(?=.{1,63}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/. Note that if a template string is used in the name of a module in a template, then the template string must be fully resolvable at the time of module scanning. This means that e.g. references to other modules or runtime outputs cannot be used.'
          )
      )
    })
  })
})
