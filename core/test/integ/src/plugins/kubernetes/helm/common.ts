/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { TestGarden, makeTestGarden, dataDir, expectError } from "../../../../../helpers"
import { resolve } from "path"
import { expect } from "chai"
import { first, uniq } from "lodash"

import {
  containsSource,
  getChartResources,
  getChartPath,
  getReleaseName,
  getGardenValuesPath,
  getBaseModule,
  getValueArgs,
  renderTemplates,
} from "../../../../../../src/plugins/kubernetes/helm/common"
import { LogEntry } from "../../../../../../src/logger/log-entry"
import { BuildTask } from "../../../../../../src/tasks/build"
import { deline, dedent } from "../../../../../../src/util/string"
import { ConfigGraph } from "../../../../../../src/config-graph"
import { KubernetesPluginContext } from "../../../../../../src/plugins/kubernetes/config"
import { safeLoadAll } from "js-yaml"
import { Garden } from "../../../../../../src"

let helmTestGarden: TestGarden

export async function getHelmTestGarden() {
  if (helmTestGarden) {
    return helmTestGarden
  }

  const projectRoot = resolve(dataDir, "test-projects", "helm")
  const garden = await makeTestGarden(projectRoot)

  helmTestGarden = garden

  return garden
}

export async function buildHelmModules(garden: Garden | TestGarden, graph: ConfigGraph) {
  const modules = graph.getModules()
  const tasks = modules.map(
    (module) =>
      new BuildTask({
        garden,
        graph,
        log: garden.log,
        module,
        force: false,
        _guard: true,
      })
  )
  const results = await garden.processTasks(tasks)

  const err = first(Object.values(results).map((r) => r && r.error))

  if (err) {
    throw err
  }
}

describe("Helm common functions", () => {
  let garden: TestGarden
  let graph: ConfigGraph
  let ctx: KubernetesPluginContext
  let log: LogEntry

  before(async () => {
    garden = await getHelmTestGarden()
    const provider = await garden.resolveProvider(garden.log, "local-kubernetes")
    ctx = (await garden.getPluginContext(provider)) as KubernetesPluginContext
    log = garden.log
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    await buildHelmModules(garden, graph)
  })

  beforeEach(async () => {
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
  })

  describe("containsSource", () => {
    it("should return true if the specified module contains chart sources", async () => {
      const module = graph.getModule("api")
      expect(await containsSource(module)).to.be.true
    })

    it("should return false if the specified module does not contain chart sources", async () => {
      const module = graph.getModule("postgres")
      expect(await containsSource(module)).to.be.false
    })
  })

  describe("renderTemplates", () => {
    it("should render and return the manifests for a local template", async () => {
      const module = graph.getModule("api")
      const imageModule = graph.getModule("api-image")
      const templates = await renderTemplates({
        ctx,
        module,
        devMode: false,
        hotReload: false,
        log,
        version: module.version.versionString,
      })

      expect(templates).to.eql(dedent`
      ---
      # Source: api/templates/service.yaml
      apiVersion: v1
      kind: Service
      metadata:
        name: api-release
        labels:
          app.kubernetes.io/name: api
          helm.sh/chart: api-0.1.0
          app.kubernetes.io/instance: api-release
          app.kubernetes.io/managed-by: Helm
      spec:
        type: ClusterIP
        ports:
          - port: 80
            targetPort: http
            protocol: TCP
            name: http
        selector:
          app.kubernetes.io/name: api
          app.kubernetes.io/instance: api-release
      ---
      # Source: api/templates/deployment.yaml
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: api-release
        labels:
          app.kubernetes.io/name: api
          helm.sh/chart: api-0.1.0
          app.kubernetes.io/instance: api-release
          app.kubernetes.io/managed-by: Helm
      spec:
        replicas: 1
        selector:
          matchLabels:
            app.kubernetes.io/name: api
            app.kubernetes.io/instance: api-release
        template:
          metadata:
            labels:
              app.kubernetes.io/name: api
              app.kubernetes.io/instance: api-release
          spec:
            containers:
              - name: api
                image: "api-image:${imageModule.version.versionString}"
                imagePullPolicy: IfNotPresent
                args: [python, app.py]
                ports:
                  - name: http
                    containerPort: 80
                    protocol: TCP
                resources:
                  {}
      ---
      # Source: api/templates/ingress.yaml
      apiVersion: extensions/v1beta1
      kind: Ingress
      metadata:
        name: api-release
        labels:
          app.kubernetes.io/name: api
          helm.sh/chart: api-0.1.0
          app.kubernetes.io/instance: api-release
          app.kubernetes.io/managed-by: Helm
      spec:
        rules:
          - host: "api.local.app.garden"
            http:
              paths:
                - path: /
                  backend:
                    serviceName: api-release
                    servicePort: http\n
      `)
    })

    it("should render and return the manifests for a remote template", async () => {
      const module = graph.getModule("postgres")
      const templates = await renderTemplates({
        ctx,
        module,
        devMode: false,
        hotReload: false,
        log,
        version: module.version.versionString,
      })

      // The exact output will vary by K8s versions so we just validate that we get valid YAML and
      // the expected kinds.
      const parsed = safeLoadAll(templates)
      expect(parsed.length).to.equal(4)

      const kinds = uniq(parsed.map((p) => p.kind)).sort()
      expect(kinds).to.eql(["Secret", "Service", "StatefulSet"])
    })
  })

  describe("getChartResources", () => {
    it("should render and return resources for a local template", async () => {
      const module = graph.getModule("api")
      const resources = await getChartResources({
        ctx,
        module,
        devMode: false,
        hotReload: false,
        log,
        version: module.version.versionString,
      })

      expect(resources).to.eql([
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: "api-release",
            labels: {
              "app.kubernetes.io/name": "api",
              "helm.sh/chart": "api-0.1.0",
              "app.kubernetes.io/instance": "api-release",
              "app.kubernetes.io/managed-by": "Helm",
            },
            annotations: {},
          },
          spec: {
            type: "ClusterIP",
            ports: [
              {
                port: 80,
                targetPort: "http",
                protocol: "TCP",
                name: "http",
              },
            ],
            selector: {
              "app.kubernetes.io/name": "api",
              "app.kubernetes.io/instance": "api-release",
            },
          },
        },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api-release",
            labels: {
              "app.kubernetes.io/name": "api",
              "helm.sh/chart": "api-0.1.0",
              "app.kubernetes.io/instance": "api-release",
              "app.kubernetes.io/managed-by": "Helm",
            },
            annotations: {},
          },
          spec: {
            replicas: 1,
            selector: {
              matchLabels: {
                "app.kubernetes.io/name": "api",
                "app.kubernetes.io/instance": "api-release",
              },
            },
            template: {
              metadata: {
                labels: {
                  "app.kubernetes.io/name": "api",
                  "app.kubernetes.io/instance": "api-release",
                },
              },
              spec: {
                containers: [
                  {
                    name: "api",
                    image: resources[1].spec.template.spec.containers[0].image,
                    imagePullPolicy: "IfNotPresent",
                    args: ["python", "app.py"],
                    ports: [
                      {
                        name: "http",
                        containerPort: 80,
                        protocol: "TCP",
                      },
                    ],
                    resources: {},
                  },
                ],
              },
            },
          },
        },
        {
          apiVersion: "extensions/v1beta1",
          kind: "Ingress",
          metadata: {
            name: "api-release",
            labels: {
              "app.kubernetes.io/name": "api",
              "helm.sh/chart": "api-0.1.0",
              "app.kubernetes.io/instance": "api-release",
              "app.kubernetes.io/managed-by": "Helm",
            },
            annotations: {},
          },
          spec: {
            rules: [
              {
                host: "api.local.app.garden",
                http: {
                  paths: [
                    {
                      path: "/",
                      backend: {
                        serviceName: "api-release",
                        servicePort: "http",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ])
    })

    it("should render and return resources for a remote template", async () => {
      const module = graph.getModule("postgres")
      const resources = await getChartResources({
        ctx,
        module,
        devMode: false,
        hotReload: false,
        log,
        version: module.version.versionString,
      })

      // The exact output will vary by K8s versions so we just validate that we get valid YAML and
      // the expected kinds.
      expect(resources.length).to.equal(4)

      const kinds = uniq(resources.map((p) => p.kind)).sort()
      expect(kinds).to.eql(["Secret", "Service", "StatefulSet"])
    })

    it("should handle duplicate keys in template", async () => {
      const module = graph.getModule("duplicate-keys-in-template")
      expect(
        await getChartResources({
          ctx,
          module,
          devMode: false,
          hotReload: false,
          log,
          version: module.version.versionString,
        })
      ).to.not.throw
    })

    it("should filter out resources with hooks", async () => {
      const module = graph.getModule("chart-with-test-pod")
      const resources = await getChartResources({
        ctx,
        module,
        devMode: false,
        hotReload: false,
        log,
        version: module.version.versionString,
      })

      expect(resources).to.eql([
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            annotations: {},
            name: "chart-with-test-pod",
          },
          spec: {
            ports: [
              {
                name: "http",
                port: 80,
              },
            ],
            selector: {
              app: "chart-with-test-pod",
            },
            type: "ClusterIP",
          },
        },
      ])
    })
  })

  describe("getBaseModule", () => {
    it("should return undefined if no base module is specified", async () => {
      const module = graph.getModule("api")

      expect(await getBaseModule(module)).to.be.undefined
    })

    it("should return the resolved base module if specified", async () => {
      const module = graph.getModule("api")
      const baseModule = graph.getModule("postgres")

      module.spec.base = baseModule.name
      module.buildDependencies = { postgres: baseModule }

      expect(await getBaseModule(module)).to.equal(baseModule)
    })

    it("should throw if the base module isn't in the build dependency map", async () => {
      const module = graph.getModule("api")

      module.spec.base = "postgres"

      await expectError(
        () => getBaseModule(module),
        (err) =>
          expect(err.message).to.equal(
            deline`Helm module 'api' references base module 'postgres' but it is missing from the module's build dependencies.`
          )
      )
    })

    it("should throw if the base module isn't a Helm module", async () => {
      const module = graph.getModule("api")
      const baseModule = graph.getModule("postgres")

      baseModule.type = "foo"

      module.spec.base = baseModule.name
      module.buildDependencies = { postgres: baseModule }

      await expectError(
        () => getBaseModule(module),
        (err) =>
          expect(err.message).to.equal(
            deline`Helm module 'api' references base module 'postgres' which is a 'foo' module,
            but should be a helm module.`
          )
      )
    })
  })

  describe("getChartPath", () => {
    context("module has chart sources", () => {
      it("should return the chart path in the build directory", async () => {
        const module = graph.getModule("api")
        expect(await getChartPath(module)).to.equal(resolve(ctx.projectRoot, ".garden", "build", "api"))
      })
    })

    context("module references remote chart", () => {
      it("should construct the chart path based on the chart name", async () => {
        const module = graph.getModule("postgres")
        expect(await getChartPath(module)).to.equal(
          resolve(ctx.projectRoot, ".garden", "build", "postgres", "postgresql")
        )
      })
    })
  })

  describe("getGardenValuesPath", () => {
    it("should add garden-values.yml to the specified path", () => {
      expect(getGardenValuesPath(ctx.projectRoot)).to.equal(resolve(ctx.projectRoot, "garden-values.yml"))
    })
  })

  describe("getValueArgs", () => {
    it("should return just garden-values.yml if no valueFiles are configured", async () => {
      const module = graph.getModule("api")
      module.spec.valueFiles = []
      const gardenValuesPath = getGardenValuesPath(module.buildPath)
      expect(await getValueArgs(module, false, false)).to.eql(["--values", gardenValuesPath])
    })

    it("should add a --set flag if devMode=true", async () => {
      const module = graph.getModule("api")
      module.spec.valueFiles = []
      const gardenValuesPath = getGardenValuesPath(module.buildPath)
      expect(await getValueArgs(module, true, false)).to.eql([
        "--values",
        gardenValuesPath,
        "--set",
        "\\.garden.devMode=true",
      ])
    })

    it("should add a --set flag if hotReload=true", async () => {
      const module = graph.getModule("api")
      module.spec.valueFiles = []
      const gardenValuesPath = getGardenValuesPath(module.buildPath)
      expect(await getValueArgs(module, false, true)).to.eql([
        "--values",
        gardenValuesPath,
        "--set",
        "\\.garden.hotReload=true",
      ])
    })

    it("should return a --values arg for each valueFile configured", async () => {
      const module = graph.getModule("api")
      module.spec.valueFiles = ["foo.yaml", "bar.yaml"]
      const gardenValuesPath = getGardenValuesPath(module.buildPath)

      expect(await getValueArgs(module, false, false)).to.eql([
        "--values",
        resolve(module.buildPath, "foo.yaml"),
        "--values",
        resolve(module.buildPath, "bar.yaml"),
        "--values",
        gardenValuesPath,
      ])
    })
  })

  describe("getReleaseName", () => {
    it("should return the module name if not overridden in config", async () => {
      const module = graph.getModule("api")
      delete module.spec.releaseName
      expect(getReleaseName(module)).to.equal("api")
    })

    it("should return the configured release name if any", async () => {
      const module = graph.getModule("api")
      expect(getReleaseName(module)).to.equal("api-release")
    })
  })
})
