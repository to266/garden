/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { join } from "path"
import { expect } from "chai"
import { BaseTask, TaskType } from "../../../src/tasks/base"
import { TaskGraph, GraphResult, GraphResults } from "../../../src/task-graph"
import { makeTestGarden, freezeTime, dataDir, expectError, TestGarden } from "../../helpers"
import { Garden } from "../../../src/garden"
import { deepFilter, defer, sleep, uuidv4 } from "../../../src/util/util"
import { range } from "lodash"
import { toGraphResultEventPayload } from "../../../src/events"
import { sanitizeObject } from "../../../src/logger/util"

const projectRoot = join(dataDir, "test-project-empty")

export type TestTaskCallback = (name: string, result: any) => Promise<void>

export interface TestTaskOptions {
  callback?: TestTaskCallback
  dependencies?: BaseTask[]
  versionString?: string
  uid?: string
  throwError?: boolean
}

export class TestTask extends BaseTask {
  type: TaskType = "test"
  name: string
  callback: TestTaskCallback | null
  uid: string
  throwError: boolean

  dependencies: BaseTask[]

  constructor(garden: Garden, name: string, force: boolean, options?: TestTaskOptions) {
    super({
      garden,
      log: garden.log,
      version: (options && options.versionString) || "12345-6789",
      force,
    })

    if (!options) {
      options = {}
    }

    this.name = name
    this.callback = options.callback || null
    this.uid = options.uid || ""
    this.throwError = !!options.throwError
    this.dependencies = options.dependencies || []
  }

  async resolveDependencies() {
    return this.dependencies
  }

  getName() {
    return this.name
  }

  getKey(): string {
    return this.name
  }

  getId(): string {
    return this.uid ? `${this.name}.${this.uid}` : this.name
  }

  getDescription() {
    return this.getId()
  }

  async process(dependencyResults: GraphResults) {
    const result = { result: "result-" + this.getId(), dependencyResults }

    if (this.callback) {
      await this.callback(this.getId(), result.result)
    }

    if (this.throwError) {
      throw new Error()
    }

    return result
  }
}

describe("task-graph", () => {
  async function getGarden() {
    return makeTestGarden(projectRoot)
  }

  describe("TaskGraph", () => {
    it("should successfully process a single task without dependencies", async () => {
      const now = freezeTime()
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false)

      const results = await graph.process([task])
      const generatedBatchId = results?.a?.batchId || uuidv4()

      const expected: GraphResults = {
        a: {
          type: "test",
          description: "a",
          key: "a",
          name: "a",
          startedAt: now,
          completedAt: now,
          batchId: generatedBatchId,
          output: {
            result: "result-a",
            dependencyResults: {},
          },
          dependencyResults: {},
          version: task.version,
        },
      }

      expect(results).to.eql(expected)
    })

    it("should emit a taskPending event when adding a task", async () => {
      const now = freezeTime()

      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false)

      const result = await graph.process([task])
      const generatedBatchId = result?.a?.batchId || uuidv4()

      expect(garden.events.eventLog).to.eql([
        { name: "taskGraphProcessing", payload: { startedAt: now } },
        {
          name: "taskPending",
          payload: {
            addedAt: now,
            batchId: generatedBatchId,
            key: task.getKey(),
            name: task.name,
            type: task.type,
          },
        },
        {
          name: "taskProcessing",
          payload: {
            startedAt: now,
            batchId: generatedBatchId,
            key: task.getKey(),
            name: task.name,
            type: task.type,
            versionString: task.version,
          },
        },
        { name: "taskComplete", payload: toGraphResultEventPayload(result["a"]!) },
        { name: "taskGraphComplete", payload: { completedAt: now } },
      ])
    })

    it("should throw if tasks have circular dependencies", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const taskA = new TestTask(garden, "a", false)
      const taskB = new TestTask(garden, "b", false, { dependencies: [taskA] })
      const taskC = new TestTask(garden, "c", false, { dependencies: [taskB] })
      taskA["dependencies"] = [taskC]
      const errorMsg = "Circular task dependencies detected:\n\nb <- a <- c <- b\n"

      await expectError(
        () => graph.process([taskB]),
        (err) => expect(err.message).to.eql(errorMsg)
      )
    })

    it("should emit events when processing and completing a task", async () => {
      const now = freezeTime()

      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false)
      await graph.process([task])

      garden.events.eventLog = []

      // repeatedTask has the same key and version as task, so its result is already cached
      const repeatedTask = new TestTask(garden, "a", false)
      const results = await graph.process([repeatedTask])

      expect(garden.events.eventLog).to.eql([
        { name: "taskGraphProcessing", payload: { startedAt: now } },
        {
          name: "taskComplete",
          payload: toGraphResultEventPayload(results["a"]!),
        },
        { name: "taskGraphComplete", payload: { completedAt: now } },
      ])
    })

    it("should emit a taskError event when failing a task", async () => {
      const now = freezeTime()

      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false, { throwError: true })

      const result = await graph.process([task])
      const generatedBatchId = result?.a?.batchId || uuidv4()

      expect(garden.events.eventLog).to.eql([
        { name: "taskGraphProcessing", payload: { startedAt: now } },
        {
          name: "taskPending",
          payload: {
            addedAt: now,
            batchId: generatedBatchId,
            key: task.getKey(),
            name: task.name,
            type: task.type,
          },
        },
        {
          name: "taskProcessing",
          payload: {
            startedAt: now,
            batchId: generatedBatchId,
            key: task.getKey(),
            name: task.name,
            type: task.type,
            versionString: task.version,
          },
        },
        { name: "taskError", payload: sanitizeObject(result["a"]) },
        { name: "taskGraphComplete", payload: { completedAt: now } },
      ])
    })

    it("should have error property inside taskError event when failing a task", async () => {
      freezeTime()

      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false, { throwError: true })

      await graph.process([task])
      const taskError = garden.events.eventLog.find((obj) => obj.name === "taskError")

      expect(taskError && taskError.payload["error"]).to.exist
    })

    it("should throw on task error if throwOnError is set", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const task = new TestTask(garden, "a", false, { throwError: true })

      await expectError(
        () => graph.process([task], { throwOnError: true }),
        (err) => expect(err.message).to.include("action(s) failed")
      )
    })

    it("should include any task errors in task results", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)
      const taskA = new TestTask(garden, "a", false, { throwError: true })
      const taskB = new TestTask(garden, "b", false, { throwError: true })
      const taskC = new TestTask(garden, "c", false)

      const results = await graph.process([taskA, taskB, taskC])

      expect(results.a!.error).to.exist
      expect(results.b!.error).to.exist
      expect(results.c!.error).to.not.exist
    })

    context("if a successful result has been cached", () => {
      it("should not process a matching task with force = false", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)
        const resultCache = graph["resultCache"]

        const resultOrder: string[] = []
        const callback = async (key: string, _result: any) => {
          resultOrder.push(key)
        }
        const opts = { callback }

        const task = new TestTask(garden, "a", false, { ...opts, uid: "a1", versionString: "1" })
        await graph.process([task])
        expect(resultCache.get("a", "1")).to.exist

        const repeatedTask = new TestTask(garden, "a", false, { ...opts, uid: "a2", versionString: "1" })
        await graph.process([repeatedTask])

        expect(resultOrder).to.eql(["a.a1"])
      })

      it("should process a matching task with force = true", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)

        const resultOrder: string[] = []
        const callback = async (key: string, _result: any) => {
          resultOrder.push(key)
        }
        const opts = { callback }

        const task = new TestTask(garden, "a", true, { ...opts, uid: "a1", versionString: "1" })
        await graph.process([task])

        const repeatedTask = new TestTask(garden, "a", true, { ...opts, uid: "a2", versionString: "1" })
        await graph.process([repeatedTask])

        expect(resultOrder).to.eql(["a.a1", "a.a2"])
      })
    })

    context("if a failing result has been cached", () => {
      it("should not process a matching task with force = false", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)
        const resultCache = graph["resultCache"]

        const resultOrder: string[] = []
        const callback = async (key: string, _result: any) => {
          resultOrder.push(key)
        }
        const opts = { callback }

        const task = new TestTask(garden, "a", false, { ...opts, uid: "a1", versionString: "1", throwError: true })
        try {
          await graph.process([task])
        } catch (error) {}

        const cacheEntry = resultCache.get("a", "1")
        expect(cacheEntry, "expected cache entry to exist").to.exist

        const repeatedTask = new TestTask(garden, "a", false, { ...opts, uid: "a2", versionString: "1" })
        await graph.process([repeatedTask])

        expect(resultOrder).to.eql(["a.a1"])
      })

      it("should process a matching task with force = true", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)

        const resultOrder: string[] = []
        const callback = async (key: string, _result: any) => {
          resultOrder.push(key)
        }
        const opts = { callback }

        const task = new TestTask(garden, "a", false, { ...opts, uid: "a1", versionString: "1", throwError: true })
        try {
          await graph.process([task])
        } catch (error) {}

        const repeatedTask = new TestTask(garden, "a", true, { ...opts, uid: "a2", versionString: "1" })
        await graph.process([repeatedTask])

        expect(resultOrder).to.eql(["a.a1", "a.a2"])
      })
    })

    it("should process multiple tasks in dependency order", async () => {
      const now = freezeTime()
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)

      const callbackResults = {}
      const resultOrder: string[] = []

      const callback = async (key: string, result: any) => {
        resultOrder.push(key)
        callbackResults[key] = result
      }

      const opts = { callback }

      const taskA = new TestTask(garden, "a", false, { ...opts, dependencies: [], uid: "a1" })
      const taskB = new TestTask(garden, "b", false, { ...opts, dependencies: [taskA], uid: "b1" })
      const taskC = new TestTask(garden, "c", false, { ...opts, dependencies: [taskB], uid: "c1" })
      const taskD = new TestTask(garden, "d", false, { ...opts, dependencies: [taskB, taskC], uid: "d1" })

      // we should be able to add tasks multiple times and in any order
      const results = await graph.process([taskA, taskB, taskC, taskC, taskD, taskA, taskD, taskB, taskD, taskA])
      const generatedBatchId = results?.a?.batchId || uuidv4()

      // repeat

      const repeatCallbackResults = {}
      const repeatResultOrder: string[] = []

      const repeatCallback = async (key: string, result: any) => {
        repeatResultOrder.push(key)
        repeatCallbackResults[key] = result
      }

      const repeatOpts = { callback: repeatCallback }

      const repeatTaskA = new TestTask(garden, "a", false, { ...repeatOpts, dependencies: [], uid: "a2" })
      const repeatTaskB = new TestTask(garden, "b", false, { ...repeatOpts, dependencies: [repeatTaskA], uid: "b2" })
      const repeatTaskC = new TestTask(garden, "c", true, { ...repeatOpts, dependencies: [repeatTaskB], uid: "c2" })

      const repeatTaskAforced = new TestTask(garden, "a", true, { ...repeatOpts, dependencies: [], uid: "a2f" })
      const repeatTaskBforced = new TestTask(garden, "b", true, {
        ...repeatOpts,
        dependencies: [repeatTaskA],
        uid: "b2f",
      })

      await graph.process([repeatTaskBforced, repeatTaskAforced, repeatTaskC])

      const resultA: GraphResult = {
        type: "test",
        description: "a.a1",
        key: "a",
        name: "a",
        startedAt: now,
        completedAt: now,
        batchId: generatedBatchId,
        output: {
          result: "result-a.a1",
          dependencyResults: {},
        },
        dependencyResults: {},
        version: taskA.version,
      }
      const resultB: GraphResult = {
        type: "test",
        key: "b",
        name: "b",
        description: "b.b1",
        startedAt: now,
        completedAt: now,
        batchId: generatedBatchId,
        output: {
          result: "result-b.b1",
          dependencyResults: { a: resultA },
        },
        dependencyResults: { a: resultA },
        version: taskB.version,
      }
      const resultC: GraphResult = {
        type: "test",
        description: "c.c1",
        key: "c",
        name: "c",
        startedAt: now,
        completedAt: now,
        batchId: generatedBatchId,
        output: {
          result: "result-c.c1",
          dependencyResults: { b: resultB },
        },
        dependencyResults: { b: resultB },
        version: taskC.version,
      }

      const expected: GraphResults = {
        a: resultA,
        b: resultB,
        c: resultC,
        d: {
          type: "test",
          description: "d.d1",
          key: "d",
          name: "d",
          startedAt: now,
          completedAt: now,
          batchId: generatedBatchId,
          output: {
            result: "result-d.d1",
            dependencyResults: {
              b: resultB,
              c: resultC,
            },
          },
          dependencyResults: {
            b: resultB,
            c: resultC,
          },
          version: taskD.version,
        },
      }

      expect(results).to.eql(expected, "Wrong results after initial add and process")
      expect(resultOrder).to.eql(["a.a1", "b.b1", "c.c1", "d.d1"], "Wrong result order after initial add and process")

      expect(callbackResults).to.eql(
        {
          "a.a1": "result-a.a1",
          "b.b1": "result-b.b1",
          "c.c1": "result-c.c1",
          "d.d1": "result-d.d1",
        },
        "Wrong callbackResults after initial add and process"
      )

      expect(repeatResultOrder).to.eql(["a.a2f", "b.b2f", "c.c2"], "Wrong result order after repeat add & process")

      expect(repeatCallbackResults).to.eql(
        {
          "a.a2f": "result-a.a2f",
          "b.b2f": "result-b.b2f",
          "c.c2": "result-c.c2",
        },
        "Wrong callbackResults after repeat add & process"
      )
    })

    it("should add at most one pending task for a given key", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)

      const processedVersions: string[] = []

      const { promise: t1StartedPromise, resolver: t1StartedResolver } = defer()
      const { promise: t1DonePromise, resolver: t1DoneResolver } = defer()

      const t1 = new TestTask(garden, "a", false, {
        versionString: "1",
        uid: "1",
        callback: async () => {
          t1StartedResolver()
          processedVersions.push("1")
          await t1DonePromise
        },
      })

      const repeatedCallback = (version: string) => {
        return async () => {
          processedVersions.push(version)
        }
      }
      const t2 = new TestTask(garden, "a", false, { uid: "2", versionString: "2", callback: repeatedCallback("2") })
      const t3 = new TestTask(garden, "a", false, { uid: "3", versionString: "3", callback: repeatedCallback("3") })

      const firstProcess = graph.process([t1])

      // We make sure t1 is being processed before adding t2 and t3. Since t3 is added after t2,
      // only t1 and t3 should be processed (since t2 and t3 have the same key, "a").
      await t1StartedPromise
      const secondProcess = graph.process([t2])
      const thirdProcess = graph.process([t3])
      await sleep(200) // TODO: Get rid of this?
      t1DoneResolver()
      await Bluebird.all([firstProcess, secondProcess, thirdProcess])
      expect(processedVersions).to.eql(["1", "3"])
    })

    it("should process requests with unrelated tasks concurrently", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)

      const resultOrder: string[] = []

      const callback = async (key: string) => {
        resultOrder.push(key)
      }

      const { resolver: aStartedResolver } = defer()
      const { promise: aDonePromise, resolver: aDoneResolver } = defer()

      const opts = { callback }
      const taskADep1 = new TestTask(garden, "a-dep1", false, { ...opts })
      const taskADep2 = new TestTask(garden, "a-dep2", false, { ...opts })

      const taskA = new TestTask(garden, "a", false, {
        dependencies: [taskADep1, taskADep2],
        callback: async () => {
          aStartedResolver()
          resultOrder.push("a")
          await aDonePromise
        },
      })

      const taskBDep = new TestTask(garden, "b-dep", false, { ...opts })
      const taskB = new TestTask(garden, "b", false, { ...opts, dependencies: [taskBDep] })
      const taskC = new TestTask(garden, "c", false, { ...opts })

      const firstProcess = graph.process([taskA, taskADep1, taskADep2])
      const secondProcess = graph.process([taskB, taskBDep])
      const thirdProcess = graph.process([taskC])
      aDoneResolver()
      await Bluebird.all([firstProcess, secondProcess, thirdProcess])
      expect(resultOrder).to.eql(["c", "a-dep1", "a-dep2", "b-dep", "a", "b"])
    })

    it("should process two requests with related tasks sequentially", async () => {
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)

      const resultOrder: string[] = []

      const callback = async (key: string) => {
        resultOrder.push(key)
      }

      const { resolver: aStartedResolver } = defer()
      const { promise: aDonePromise, resolver: aDoneResolver } = defer()

      const opts = { callback }
      const taskADep = new TestTask(garden, "a-dep1", true, { ...opts })

      const taskA = new TestTask(garden, "a", true, {
        dependencies: [taskADep],
        callback: async () => {
          aStartedResolver()
          resultOrder.push("a")
          await aDonePromise
        },
      })

      const repeatTaskBDep = new TestTask(garden, "b-dep", true, { ...opts })

      const firstProcess = graph.process([taskA, taskADep])
      const secondProcess = graph.process([repeatTaskBDep])
      aDoneResolver()
      await Bluebird.all([firstProcess, secondProcess])
      expect(resultOrder).to.eql(["b-dep", "a-dep1", "a"])
    })

    it("should enforce a hard concurrency limit on task processing", async () => {
      const garden = await getGarden()
      const tasks = range(0, 10).map((n) => new TestTask(garden, "task-" + n, false))
      const limit = 3
      const graph = new TaskGraph(garden, garden.log, limit)
      let gotEvents = false

      graph.on("process", (event) => {
        gotEvents = true
        // Ensure we never go over the hard limit
        expect(event.keys.length + event.inProgress.length).to.lte(limit)
      })

      await graph.process(tasks)

      expect(gotEvents).to.be.true
    })

    it("should enforce a concurrency limit per task type", async () => {
      const garden = await getGarden()
      const limit = 2

      class TaskTypeA extends TestTask {
        type = <TaskType>"a"
        concurrencyLimit = limit
      }

      class TaskTypeB extends TestTask {
        type = <TaskType>"b"
        concurrencyLimit = limit
      }

      const tasks = [
        ...range(0, 10).map((n) => new TaskTypeA(garden, "a-" + n, false)),
        ...range(0, 10).map((n) => new TaskTypeB(garden, "b-" + n, false)),
      ]

      const graph = new TaskGraph(garden, garden.log)

      let gotEvents = false

      graph.on("process", (event) => {
        gotEvents = true
        // Ensure not more than two of each task type run concurrently
        for (const type of ["a", "b"]) {
          const keys = [...event.keys, ...event.inProgress].filter((key) => key.startsWith(type))
          expect(keys.length).to.lte(limit)
        }
      })

      await graph.process(tasks)

      expect(gotEvents).to.be.true
    })

    it("should recursively cancel a task's dependants when it throws an error", async () => {
      const now = freezeTime()
      const garden = await getGarden()
      const graph = new TaskGraph(garden, garden.log)

      const resultOrder: string[] = []

      const callback = async (key: string) => {
        resultOrder.push(key)
      }

      const opts = { callback }

      const taskA = new TestTask(garden, "a", true, { ...opts })
      const taskB = new TestTask(garden, "b", true, { callback, throwError: true, dependencies: [taskA] })
      const taskC = new TestTask(garden, "c", true, { ...opts, dependencies: [taskB] })
      const taskD = new TestTask(garden, "d", true, { ...opts, dependencies: [taskB, taskC] })

      const results = await graph.process([taskA, taskB, taskC, taskD])

      const generatedBatchId = results?.a?.batchId || uuidv4()

      const resultA: GraphResult = {
        type: "test",
        description: "a",
        key: "a",
        name: "a",
        startedAt: now,
        completedAt: now,
        batchId: generatedBatchId,
        output: {
          result: "result-a",
          dependencyResults: {},
        },
        dependencyResults: {},
        version: taskA.version,
      }

      const filteredKeys: Set<string | number> = new Set([
        "version",
        "versionString",
        "error",
        "addedAt",
        "startedAt",
        "cancelledAt",
        "completedAt",
      ])

      const filteredEventLog = garden.events.eventLog.map((e) => {
        return deepFilter(e, (_, key) => !filteredKeys.has(key))
      })

      expect(results.a).to.eql(resultA)
      expect(results.b).to.have.property("error")
      expect(resultOrder).to.eql(["a", "b"])
      expect(filteredEventLog).to.eql([
        { name: "taskGraphProcessing", payload: {} },
        { name: "taskPending", payload: { key: "a", name: "a", type: "test", batchId: generatedBatchId } },
        { name: "taskPending", payload: { key: "b", name: "b", type: "test", batchId: generatedBatchId } },
        { name: "taskPending", payload: { key: "c", name: "c", type: "test", batchId: generatedBatchId } },
        { name: "taskPending", payload: { key: "d", name: "d", type: "test", batchId: generatedBatchId } },
        { name: "taskProcessing", payload: { key: "a", name: "a", type: "test", batchId: generatedBatchId } },
        {
          name: "taskComplete",
          payload: {
            description: "a",
            key: "a",
            name: "a",
            type: "test",
            batchId: generatedBatchId,
            output: { result: "result-a" },
          },
        },
        { name: "taskProcessing", payload: { key: "b", name: "b", type: "test", batchId: generatedBatchId } },
        {
          name: "taskError",
          payload: { description: "b", key: "b", name: "b", type: "test", batchId: generatedBatchId },
        },
        { name: "taskCancelled", payload: { key: "c", name: "c", type: "test", batchId: generatedBatchId } },
        { name: "taskCancelled", payload: { key: "d", name: "d", type: "test", batchId: generatedBatchId } },
        { name: "taskCancelled", payload: { key: "d", name: "d", type: "test", batchId: generatedBatchId } },
        { name: "taskGraphComplete", payload: {} },
      ])
    })

    context("if a cached, failing result exists for a task", () => {
      let garden: TestGarden
      let graph: TaskGraph

      beforeEach(async () => {
        garden = await getGarden()
        graph = new TaskGraph(garden, garden.log)

        const opts = { versionString: "1" }

        const taskA = new TestTask(garden, "a", false, { ...opts, uid: "a1" })
        const taskB = new TestTask(garden, "b", false, { ...opts, uid: "b1", throwError: true, dependencies: [taskA] })
        const taskC = new TestTask(garden, "c", false, { ...opts, uid: "c1", dependencies: [taskB] })
        const taskD = new TestTask(garden, "d", false, { ...opts, uid: "d1", dependencies: [taskB, taskC] })

        await graph.process([taskA, taskB, taskC, taskD])

        garden.events.eventLog = []
      })

      it("should recursively cancel dependants if it has a cached, failing result at the same version", async () => {
        const repOpts = { versionString: "1" }

        const repTaskA = new TestTask(garden, "a", false, { ...repOpts, uid: "a2" })
        const repTaskB = new TestTask(garden, "b", false, {
          ...repOpts,
          uid: "b2",
          throwError: true,
          dependencies: [repTaskA],
        })
        const repTaskC = new TestTask(garden, "c", false, { ...repOpts, uid: "c2", dependencies: [repTaskB] })
        const repTaskD = new TestTask(garden, "d", false, { ...repOpts, uid: "d2", dependencies: [repTaskB, repTaskC] })

        await graph.process([repTaskA, repTaskB, repTaskC, repTaskD])

        const filteredEventLog = garden.events.eventLog.map((e) => {
          return { name: e.name, payload: deepFilter(e.payload, (_, key) => key === "key") }
        })

        expect(filteredEventLog).to.eql([
          { name: "taskGraphProcessing", payload: {} },
          { name: "taskComplete", payload: { key: "a" } },
          { name: "taskError", payload: { key: "b" } },
          { name: "taskCancelled", payload: { key: "c" } },
          { name: "taskCancelled", payload: { key: "d" } },
          { name: "taskCancelled", payload: { key: "c" } },
          { name: "taskGraphComplete", payload: {} },
        ])
      })

      it("should run a task with force = true if it has a cached, failing result at the same version", async () => {
        const repOpts = { versionString: "1" }

        const repTaskA = new TestTask(garden, "a", true, { ...repOpts, uid: "a2" })
        const repTaskB = new TestTask(garden, "b", true, {
          ...repOpts,
          uid: "b2",
          throwError: true,
          dependencies: [repTaskA],
        })
        const repTaskC = new TestTask(garden, "c", true, { ...repOpts, uid: "c2", dependencies: [repTaskB] })
        const repTaskD = new TestTask(garden, "d", true, { ...repOpts, uid: "d2", dependencies: [repTaskB, repTaskC] })

        await graph.process([repTaskA, repTaskB, repTaskC, repTaskD])

        const filteredEventLog = garden.events.eventLog.map((e) => {
          return { name: e.name, payload: deepFilter(e.payload, (_, key) => key === "key") }
        })

        expect(filteredEventLog).to.eql([
          { name: "taskGraphProcessing", payload: {} },
          { name: "taskPending", payload: { key: "a" } },
          { name: "taskPending", payload: { key: "b" } },
          { name: "taskPending", payload: { key: "c" } },
          { name: "taskPending", payload: { key: "d" } },
          { name: "taskProcessing", payload: { key: "a" } },
          { name: "taskComplete", payload: { key: "a" } },
          { name: "taskProcessing", payload: { key: "b" } },
          { name: "taskError", payload: { key: "b" } },
          { name: "taskCancelled", payload: { key: "c" } },
          { name: "taskCancelled", payload: { key: "d" } },
          { name: "taskCancelled", payload: { key: "d" } },
          { name: "taskGraphComplete", payload: {} },
        ])
      })

      it("should run a task if it has a cached, failing result at a different version", async () => {
        const repOpts = { versionString: "2" }

        const repTaskA = new TestTask(garden, "a", false, { ...repOpts, uid: "a2" })
        // No error this time
        const repTaskB = new TestTask(garden, "b", false, { ...repOpts, uid: "b2", dependencies: [repTaskA] })
        const repTaskC = new TestTask(garden, "c", false, { ...repOpts, uid: "c2", dependencies: [repTaskB] })
        const repTaskD = new TestTask(garden, "d", false, { ...repOpts, uid: "d2", dependencies: [repTaskB, repTaskC] })

        await graph.process([repTaskA, repTaskB, repTaskC, repTaskD])

        const filteredEventLog = garden.events.eventLog.map((e) => {
          return { name: e.name, payload: deepFilter(e.payload, (_, key) => key === "key") }
        })

        expect(filteredEventLog).to.eql([
          { name: "taskGraphProcessing", payload: {} },
          { name: "taskPending", payload: { key: "a" } },
          { name: "taskPending", payload: { key: "b" } },
          { name: "taskPending", payload: { key: "c" } },
          { name: "taskPending", payload: { key: "d" } },
          { name: "taskProcessing", payload: { key: "a" } },
          { name: "taskComplete", payload: { key: "a" } },
          { name: "taskProcessing", payload: { key: "b" } },
          { name: "taskComplete", payload: { key: "b" } },
          { name: "taskProcessing", payload: { key: "c" } },
          { name: "taskComplete", payload: { key: "c" } },
          { name: "taskProcessing", payload: { key: "d" } },
          { name: "taskComplete", payload: { key: "d" } },
          { name: "taskGraphComplete", payload: {} },
        ])
      })
    })

    describe("partition", () => {
      it("should partition a task list into unrelated batches", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)

        const taskADep1 = new TestTask(garden, "a-dep1", false)
        const taskADep2 = new TestTask(garden, "a-dep2", false)
        const taskA = new TestTask(garden, "a", false, { dependencies: [taskADep1, taskADep2] })
        const taskBDep = new TestTask(garden, "b-dep", false)
        const taskB = new TestTask(garden, "b", false, { dependencies: [taskBDep] })
        const taskC = new TestTask(garden, "c", false)

        const tasks = [taskA, taskB, taskC, taskADep1, taskBDep, taskADep2]
        const taskNodes = await graph["nodesWithDependencies"]({
          tasks,
          nodeMap: {},
          stack: [],
        })
        const batches = graph.partition(taskNodes)
        const batchKeys = batches.map((b) => b.nodes.map((n) => n.key))

        expect(batchKeys).to.eql([["a", "a-dep1", "a-dep2"], ["b", "b-dep"], ["c"]])
      })

      it("should correctly deduplicate and partition tasks by key and version", async () => {
        const garden = await getGarden()
        const graph = new TaskGraph(garden, garden.log)

        // Version 1 of task A, and its dependencies
        const taskAv1Dep1 = new TestTask(garden, "a-v1-dep1", false)
        const taskAv1Dep2 = new TestTask(garden, "a-v1-dep2", false)
        const taskAv1 = new TestTask(garden, "a-v1", false, { dependencies: [taskAv1Dep1, taskAv1Dep2] })

        // Version 2 of task A, and its dependencies
        const taskAv2Dep1 = new TestTask(garden, "a-v2-dep1", false)
        const taskAv2Dep2 = new TestTask(garden, "a-v2-dep2", false)
        const taskAv2 = new TestTask(garden, "a-v2", false, { dependencies: [taskAv2Dep1, taskAv2Dep2] })

        // A duplicate of task A at version 1, and its dependencies
        const dupTaskAv1Dep1 = new TestTask(garden, "a-v1-dep1", false)
        const dupTaskAv1Dep2 = new TestTask(garden, "a-v1-dep2", false)
        const dupTaskAv1 = new TestTask(garden, "a-v1", false, { dependencies: [dupTaskAv1Dep1, dupTaskAv1Dep2] })

        const taskBDep = new TestTask(garden, "b-dep", false)
        const taskB = new TestTask(garden, "b", false, { dependencies: [taskBDep] })
        const taskC = new TestTask(garden, "c", false)

        const tasks = [
          taskAv1,
          taskAv1Dep1,
          taskAv1Dep2,
          taskAv2,
          taskAv2Dep1,
          taskAv2Dep2,
          dupTaskAv1,
          dupTaskAv1Dep1,
          dupTaskAv1Dep2,
          taskB,
          taskBDep,
          taskC,
        ]

        const taskNodes = await graph["nodesWithDependencies"]({
          tasks,
          nodeMap: {},
          stack: [],
        })
        const batches = graph.partition(taskNodes)
        const batchKeys = batches.map((b) => b.nodes.map((n) => n.key))

        expect(batchKeys).to.eql([
          ["a-v1", "a-v1-dep1", "a-v1-dep2"],
          ["a-v2", "a-v2-dep1", "a-v2-dep2"],
          ["b", "b-dep"],
          ["c"],
        ])
      })
    })
  })
})
