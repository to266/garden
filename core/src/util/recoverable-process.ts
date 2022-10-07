/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ChildProcess, execFile, spawn } from "child_process"
import { LogEntry } from "../logger/log-entry"
import { sleep } from "./util"
import { ConfigurationError, RuntimeError } from "../exceptions"

export interface OsCommand {
  readonly command: string
  readonly args?: string[]
  readonly cwd?: string
  readonly description?: string
}

export const renderOsCommand = (cmd: OsCommand): string => JSON.stringify(cmd)

export interface ProcessMessage {
  readonly pid: number
  readonly processDescription: string
  readonly message: string
  readonly error?: any
  readonly code?: number
  readonly signal?: NodeJS.Signals
  readonly retryInfo?: RetryInfo
}

export interface RetryInfo {
  readonly maxRetries: number
  readonly minTimeoutMs: number
  readonly retriesLeft: number
}

export interface IOStreamListener {
  /**
   * Optional function to catch and process the critical (i.e. non-recoverable) errors.
   *
   * @param chunk the data chuck from the stdio stream
   * @return {@code true} if any critical errors have been caught or {@code false} otherwise
   */
  readonly catchCriticalErrors?: (chunk: any) => boolean

  /**
   * Some stderr output may not contain any actual errors, it can have just warnings or some debug output.
   * We want to have a way to recognize command specific warnings and do not interpret those as errors,
   * i.e. we want to avoid restarting the process.
   *
   * Alternatively, stdout may contain some info which can be interpreted as an error.
   * Thus, there is also a way to recognize some errors coming from stdout
   * (if there are any utilities which print errors to stdout?) and to trigger the process restart.
   *
   * @param chunk the data chuck from the stdio stream
   * @return {@code true} if the stderr data has any actual errors or {@code false} otherwise
   */
  readonly hasErrors: (chunk: any) => boolean

  /**
   * Allows to define some process specific error handling.
   * This function will be called if {@link #hasErrors} returned {@code true}.
   *
   * @param msg the details of the error output from the stdio stream
   */
  readonly onError: (msg: ProcessMessage) => void

  /**
   * Allows to define some process specific normal output handling.
   * This function will be called if {@link #hasErrors} returned {@code false}.
   *
   * @param msg the details of the normal output from the stdio stream
   */
  readonly onMessage: (msg: ProcessMessage) => void
}

export type CommandExecutor = (command: OsCommand) => ChildProcess

export namespace CommandExecutors {
  export const spawnExecutor: CommandExecutor = (osCommand: OsCommand) =>
    spawn(osCommand.command, osCommand.args, { cwd: osCommand.cwd, shell: true })
  export const execExecutor: CommandExecutor = (osCommand: OsCommand) =>
    execFile(osCommand.command, osCommand.args, { cwd: osCommand.cwd })
  // no fork executor support yet
}

export type FailureHandler = () => Promise<void>

export interface RecoverableProcessConfig {
  readonly osCommand: OsCommand
  readonly executor?: CommandExecutor
  readonly retryConfig: RetryConfig
  readonly stderrListener?: IOStreamListener
  readonly stdoutListener?: IOStreamListener
  readonly log: LogEntry
}

export interface RetryConfig {
  /**
   * Max number of retries. Cannot be negative. Zero means no retries.
   */
  readonly maxRetries: number
  /**
   * Min delay between retries. Cannot be negative. Zero means no delay and immediate retry.
   */
  readonly minTimeoutMs: number
}

export function validateRetryConfig(retryConfig: RetryConfig): RetryConfig {
  const requireNonNegative = (value: number, name: string): void => {
    if (value < 0) {
      throw new ConfigurationError(`Value ${name} cannot be negative: ${value}`, { name: value })
    }
  }
  requireNonNegative(retryConfig.maxRetries, "maxRetries")
  requireNonNegative(retryConfig.minTimeoutMs, "minTimeoutMs")
  return retryConfig
}

export type InitialProcessState = "runnable"
export type ActiveProcessState = "running" | "retrying"
/**
 * Process in the state "stopped" can not be retried or restarted.
 * If all retry attempts have failed, then the process reaches the "failed" state.
 * Both "stopped" and ""failed" are final states.
 */
export type InactiveProcessState = "stopped" | "failed"
/**
 * Special set of states to be used with {@link RecoverableProcess#stopNode()}.
 * State "retrying" is used to stop the process temporarily while doing a retry.
 * State "stopped" is used to stop the process permanently.
 */
export type InterruptedProcessState = "retrying" | "stopped"
export type RecoverableProcessState = InitialProcessState | ActiveProcessState | InactiveProcessState

/**
 * Motivation.
 *
 * This class was initially designed to support fault-tolerant 2-layer port-forward in the scope of
 * "local mode" deployment feature implementation.
 * The 2-layer term means that one port-forward operates on top of another.
 * That 2-layer port-forward ensures a connection between a proxy container in a remote cluster
 * and a locally deployed application.
 *
 * That connection must meet 2 requirements:
 *  - it must run in background
 *  - it must be fault-tolerant
 *
 * Here, fault-tolerance means that the connection should be able to recover automatically
 * if any of its port-forwards crashes.
 * Moreover, there is a parent-child relations between port-forwards. So, if the first port-forward crashes,
 * it will cause failure of the second one (which operates on top of the first one).
 * Thus, in case of a single port-forward failure, it must recover with all its children.
 *
 * Each port-forward is a single OS process.
 * Let's refer a single background, parent-child aware fault-tolerant process as a "persistent" process.
 *
 * In general, the connection from the example above can be considered as a composition of some persistent processes.
 * That composition connects the processes with parent-child relations. Let's assume that:
 *  - each single process depends on only 1 process (i.e. it has only parent)
 *  - each process can have multiple children
 *
 * Under these assumptions, the composition of the persistent processes can be represented by a tree data structure.
 * The tree data structure reflects the parent-child relationships between the persistent processes.
 *
 * NOTE! Generally, a single process can have multiple parent processes, but that is a more complex case
 * which is not required yet. It can be implemented in the future versions.
 *
 * This class represents a tree of persistent processes. Fault-tolerance is ensured by retries.
 *
 * Technical details.
 *
 * NOTE! The {@link RecoverableProcess.command} should start exactly one OS process.
 * This means that the command should produce exactly one PID, and it can't contain any piped processes
 * or other process chains. It can be a shell script or an application that spawn own child processes.
 * If the command has a process chain then it's not guaranteed to work properly with this utility.
 *
 * Each tree node is a wrapper on top of a {@link ChildProcess} object and stores the necessary state
 * about the current process state and its retries.
 * Each node's process failure causes a retry for the node's own process and all processes of the whole subtree.
 *
 * The retrying mechanism is build on the basis of the event handler of {@link ChildProcess} and its stdio streams.
 * The process stdio stream handling can be thoroughly customized with {@link IOStreamListener} interface.
 * It allows to handle process specific output carefully and to process the command-specific errors.
 * Both {@code stdout} and {@code stderr} streams can have own custom listeners
 * defined in {@link RecoverableProcessConfig}.
 * It's a responsibility of an implementer to keep both listeners consistent to each other.
 *
 * If there are no retries left for any process in the tree,
 * then its {@link RecoverableProcess.failureHandler} is called.
 * The failure handler function is shared across all tree nodes and it's getting called from the failed node.
 * It is a kind of finalizer which is executed after the process tree has failed and cannot be used anymore.
 * It can be a function to shutdown the application or something else. By default it is a no-op function.
 * The failure handler can be configured with {@link RecoverableProcess#setFailureHandler}.
 *
 * See {@link RecoverableProcess#startAll()} and {@link RecoverableProcess#stopAll()} to start/stop a process tree.
 *
 * TODO. Ideas on further improvements:
 *  - ability to attach/detach a process tree to/from a running process
 *  - support multiple parents if necessary
 */
export class RecoverableProcess {
  public readonly command: OsCommand
  private readonly executor: CommandExecutor
  private proc?: ChildProcess
  private lastKnownPid?: number
  private state: RecoverableProcessState

  private parent?: RecoverableProcess
  private descendants: RecoverableProcess[]

  private readonly retryConfig: RetryConfig
  private retriesLeft: number
  private failureHandler: FailureHandler

  private readonly stderrListener?: IOStreamListener
  private readonly stdoutListener?: IOStreamListener

  private readonly log: LogEntry

  constructor(config: RecoverableProcessConfig) {
    this.command = config.osCommand
    this.executor = config.executor || CommandExecutors.spawnExecutor
    this.proc = undefined
    this.lastKnownPid = undefined
    this.parent = undefined
    this.descendants = []
    this.retryConfig = validateRetryConfig(config.retryConfig)
    this.retriesLeft = config.retryConfig.maxRetries
    this.failureHandler = async () => {} // no failure handler by default
    this.stderrListener = config.stderrListener
    this.stdoutListener = config.stdoutListener
    this.log = config.log
    this.state = "runnable"
  }

  private static hasFailures(node: RecoverableProcess): boolean {
    if (node.state === "failed") {
      return true
    }
    for (const descendant of node.descendants) {
      if (RecoverableProcess.hasFailures(descendant)) {
        return true
      }
    }
    return false
  }

  public hasFailures(): boolean {
    const root = this.getTreeRoot()
    return RecoverableProcess.hasFailures(root)
  }

  public getCurrentPid(): number | undefined {
    return this.proc?.pid
  }

  public getLastKnownPid(): number | undefined {
    return this.lastKnownPid
  }

  public getProcessDescription(): string {
    return this.command.description || renderOsCommand(this.command)
  }

  public getCurrentState(): RecoverableProcessState {
    return this.state
  }

  private static recursiveAction(node: RecoverableProcess, action: (node: RecoverableProcess) => void): void {
    action(node)
    node.descendants.forEach((descendant) => RecoverableProcess.recursiveAction(descendant, action))
  }

  private stopNode(state: InterruptedProcessState): void {
    this.state = state
    const proc = this.proc
    if (!proc) {
      return
    }

    !proc.killed && proc.kill()
    this.proc = undefined
  }

  private stopSubTree(state: InterruptedProcessState): void {
    RecoverableProcess.recursiveAction(this, (node) => node.stopNode(state))
  }

  private registerNodeListeners(proc: ChildProcess): void {
    type StdIo = "stderr" | "stdout" | ""

    const processSays = (stdio: StdIo, chunk: any) =>
      !!stdio
        ? `[Process PID=${this.getCurrentPid()}] ${stdio} says "${chunk.toString()}"`
        : `[Process PID=${this.getCurrentPid()}] says "${chunk.toString()}"`

    const attemptsLeft = () =>
      !!this.retriesLeft
        ? `${this.retriesLeft} attempts left, next in ${this.retryConfig.minTimeoutMs}ms`
        : "no attempts left"

    const logDebugInfo = (stdio: StdIo, chunk: any) => this.log.debug(processSays(stdio, chunk))
    const logDebugError = (stdio: StdIo, chunk: any) =>
      this.log.debug(`${processSays(stdio, chunk)}. ${attemptsLeft()}`)

    const composeMessage = (message: string): ProcessMessage => {
      const pid = this.getCurrentPid()!
      return { pid, processDescription: this.getProcessDescription(), message }
    }

    const composeRetryInfo = (): RetryInfo => {
      const maxRetries = this.retryConfig.maxRetries
      const minTimeoutMs = this.retryConfig.minTimeoutMs
      const retriesLeft = this.retriesLeft
      return { maxRetries, minTimeoutMs, retriesLeft }
    }

    const composeErrorMessage = (message: string, error?: any): ProcessMessage => {
      const pid = this.getCurrentPid()!
      return { pid, processDescription: this.getProcessDescription(), message, retryInfo: composeRetryInfo(), error }
    }

    const composeTerminationMessage = (
      message: string,
      code: number | undefined,
      signal: NodeJS.Signals | undefined
    ): ProcessMessage => {
      const pid = this.getCurrentPid()!
      return {
        pid,
        processDescription: this.getProcessDescription(),
        message,
        retryInfo: composeRetryInfo(),
        code,
        signal,
      }
    }

    proc.on("error", async (error) => {
      const message = `Command '${renderOsCommand(this.command)}' failed with error: ${JSON.stringify(error)}`
      logDebugError("", message)
      this.stderrListener?.onError(composeErrorMessage(message, error))

      await this.tryRestartSubTree()
    })

    proc.on("close", async (code: number, signal: NodeJS.Signals) => {
      const message = `Command '${renderOsCommand(this.command)}' exited with code ${code} and signal ${signal}.`
      logDebugError("", message)
      this.stderrListener?.onError(composeTerminationMessage(message, code, signal))

      await this.tryRestartSubTree()
    })

    proc.stderr!.on("data", async (chunk: any) => {
      const catchCriticalErrorsFn = this.stderrListener?.catchCriticalErrors
      if (!!catchCriticalErrorsFn && catchCriticalErrorsFn(chunk)) {
        const message =
          `Failed to start local mode. ` +
          `Command '${renderOsCommand(this.command)}' terminated with critical error: ${chunk.toString()}.`
        logDebugError("stderr", message)
        await this.fail()
      }

      const hasErrorsFn = this.stderrListener?.hasErrors
      if (!hasErrorsFn || hasErrorsFn(chunk)) {
        const message = `Command '${renderOsCommand(this.command)}' terminated: ${chunk.toString()}.`
        logDebugError("stderr", message)
        this.stderrListener?.onError(composeErrorMessage(message))

        await this.tryRestartSubTree()
      } else {
        const message = chunk.toString()
        logDebugInfo("stderr", message)
        this.stderrListener?.onMessage(composeMessage(message))

        this.resetSubTreeRetriesLeft()
      }
    })

    proc.stdout!.on("data", async (chunk: any) => {
      const catchCriticalErrorsFn = this.stdoutListener?.catchCriticalErrors
      if (!!catchCriticalErrorsFn && catchCriticalErrorsFn(chunk)) {
        const message =
          `Failed to start local mode. ` +
          `Command '${renderOsCommand(this.command)}' terminated with critical error: ${chunk.toString()}.`
        logDebugError("stdout", message)
        await this.fail()
      }

      const hasErrorsFn = this.stdoutListener?.hasErrors
      if (!hasErrorsFn || !hasErrorsFn(chunk)) {
        const message = chunk.toString()
        logDebugInfo("stdout", message)
        this.stdoutListener?.onMessage(composeMessage(message))

        this.resetSubTreeRetriesLeft()
      } else {
        const message = `Command '${renderOsCommand(this.command)}' terminated: ${chunk.toString()}. ${attemptsLeft()}`
        logDebugError("stdout", message)
        this.stdoutListener?.onError(composeErrorMessage(message))

        await this.tryRestartSubTree()
      }
    })
  }

  private unregisterNodeListeners(): void {
    const proc = this.proc
    if (!proc) {
      return
    }

    proc.removeAllListeners("error")
    proc.removeAllListeners("close")

    proc.stdout!.removeAllListeners("data")
    proc.stderr!.removeAllListeners("data")
  }

  private unregisterSubTreeListeners(): void {
    RecoverableProcess.recursiveAction(this, (node) => node.unregisterNodeListeners())
  }

  private resetNodeRetriesLeft(): void {
    this.retriesLeft = this.retryConfig.maxRetries
  }

  private resetSubTreeRetriesLeft(): void {
    RecoverableProcess.recursiveAction(this, (node) => node.resetNodeRetriesLeft())
  }

  private async fail(): Promise<void> {
    this.log.error("Unable to start local mode, see the error details in the logs.")
    this.stopAll()
    this.state = "failed"
    await this.failureHandler()
  }

  private async tryRestartSubTree(): Promise<void> {
    if (this.state === "retrying" || this.state === "stopped") {
      return
    }
    this.state = "retrying"
    // todo: should we lookup to parent nodes to find the parent-most killed/restarting process?
    this.unregisterSubTreeListeners()
    this.stopSubTree("retrying")
    if (this.retriesLeft > 0) {
      if (this.retryConfig.minTimeoutMs > 0) {
        await sleep(this.retryConfig.minTimeoutMs)
      }
      this.retriesLeft--
      this.startSubTree()
    } else {
      await this.fail()
    }
  }

  private addDescendant(descendant: RecoverableProcess): RecoverableProcess {
    if (this.state !== "runnable") {
      throw new RuntimeError("Cannot attach a descendant to already running, stopped or failed process.", this)
    }

    descendant.parent = this
    this.descendants.push(descendant)
    return descendant
  }

  public addDescendants(...descendants: RecoverableProcess[]): RecoverableProcess[] {
    for (const descendant of descendants) {
      this.addDescendant(descendant)
    }
    return descendants
  }

  private renderProcessTreeRecursively(
    indent: string,
    output: string,
    renderer: (command: OsCommand) => string
  ): string {
    output += indent + `-> '${renderer(this.command)}'\n`
    for (const descendant of this.descendants) {
      output = descendant.renderProcessTreeRecursively(indent + "..", output, renderer)
    }
    return output
  }

  public renderProcessTree(renderer: (command: OsCommand) => string = renderOsCommand): string {
    const output = ""
    return this.renderProcessTreeRecursively("", output, renderer)
  }

  public getTreeRoot() {
    let cur: RecoverableProcess = this
    while (!!cur.parent) {
      cur = cur.parent
    }
    return cur
  }

  private startNode(): RecoverableProcess {
    if (this.state === "running") {
      return this
    }
    if (this.state === "failed") {
      throw new RuntimeError("Cannot start failed process with no retries left.", this)
    }
    if (this.state === "stopped") {
      throw new RuntimeError("Cannot start already stopped process.", this)
    }
    // no need to use pRetry here, the failures will be handled by the event process listeners
    const proc = this.executor(this.command)
    this.proc = proc
    this.lastKnownPid = proc.pid
    this.state = "running"
    this.registerNodeListeners(proc)
    return this
  }

  private static startFromNode(startNode: RecoverableProcess): RecoverableProcess {
    RecoverableProcess.recursiveAction(startNode, (node) => node.startNode())
    return startNode
  }

  private startSubTree(): RecoverableProcess {
    RecoverableProcess.startFromNode(this)
    return this
  }

  /**
   * Starts all processes in the tree starting from the parent-most one.
   * This action is idempotent.
   * It means that calling this method multiple times won't spawn any new processes,
   * the existing running process will be returned.
   *
   * Calling this on a failed process tree (i.e. if at least one tree element failed with no retries left)
   * will cause an error.
   *
   * @return the reference to the tree root, i.e. to the parent-most recoverable process
   */
  public startAll(): RecoverableProcess {
    const root = this.getTreeRoot()
    if (root.hasFailures()) {
      throw new RuntimeError("Cannot start the process tree. Some processes failed with no retries left.", this)
    }
    RecoverableProcess.startFromNode(root)
    return root
  }

  /**
   * Stops all processes in the tree starting from the parent-most one.
   * This action is idempotent.
   * It means that calling this method multiple times won't have any extra effect,
   * the existing stopped process will remain stopped.
   *
   * @return the reference to the tree root, i.e. to the parent-most recoverable process
   */
  public stopAll(): RecoverableProcess {
    const root = this.getTreeRoot()
    root.unregisterSubTreeListeners()
    root.stopSubTree("stopped")
    return root
  }

  public setFailureHandler(failureHandler: FailureHandler): void {
    const root = this.getTreeRoot()
    RecoverableProcess.recursiveAction(root, (node) => (node.failureHandler = failureHandler))
  }
}
