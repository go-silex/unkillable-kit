import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Result = { task: string; exitCode: number }
export type Outcome = { results: Result[]; code: number }
type End = { result: Result; failed: boolean; record: string }
type Slot = { task: string; output: number; printed: number; shown: boolean; end?: End }

/** How a task ended: its receipt entry, whether it failed, and the record printed after it. */
export function taskEnd(
  task: string,
  started: number,
  status: number | null,
  abnormal: boolean,
): End {
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000
  const exitCode = status ?? 1
  const failed = exitCode !== 0 || abnormal
  const record = {
    event: 'root-gate:task',
    task,
    durationMs,
    status: failed ? 'failed' : 'passed',
    exitCode,
  }
  return { result: { task, exitCode }, failed, record: `\n${JSON.stringify(record)}` }
}

/**
 * Runs the tasks `limit` at a time, started in recipe order. Once it has seen a failure it starts
 * no further task and waits for the running ones. `results` lists the started tasks in recipe
 * order.
 *
 * Each task writes to a file of its own, so the log keeps one block per task, in recipe order:
 * the earliest unfinished task is printed as it goes, a later one once those before it ended.
 * A file rather than a pipe: a task ends when its process exits, whatever it left running, and
 * its two streams stay in the order it wrote them. What it left running is printed until the
 * block of the task is closed, not after.
 *
 * An error of the run itself, as opposed to a task's, is a fault: a capture file that cannot be
 * opened, read or removed, a process that cannot be started, a write that stdout refuses. After
 * the first one no further task starts; the run waits for the running ones, then rejects with it.
 */
export function runTogether(root: string, tasks: string[], limit: number): Promise<Outcome> {
  const { promise, resolve, reject } = Promise.withResolvers<Outcome>()
  const folder = mkdtempSync(join(tmpdir(), 'root-gate-output-'))
  const started: Slot[] = []
  let running = 0
  let failed = false
  let head = 0
  let fault: { error: unknown } | undefined
  const refuse = (error: unknown) => {
    fault ??= { error }
  }
  // Every step that can throw runs in here: a callback that threw would settle nothing.
  const guard = (work: () => void) => {
    try {
      work()
      return true
    } catch (error) {
      refuse(error)
      return false
    }
  }

  // Only process.stdout.write: on a pipe, console.log would overtake what it has not flushed.
  // The run settles when stdout has answered every write. A write it refuses is a fault, whatever
  // it takes afterwards.
  let unanswered = 0
  let answered = () => {}
  process.stdout.on('error', refuse)
  const out = (data: string | Uint8Array) => {
    process.stdout.write(data, (error) => {
      if (error) refuse(error)
      unanswered -= 1
      if (unanswered === 0) answered()
    })
    // Counted after the call: a write that throws has no answer to wait for.
    unanswered += 1
  }
  const print = () => {
    for (; head < started.length; head += 1) {
      const slot = started[head]
      if (!slot.shown) out(`root-gate: running ${slot.task}\n`)
      slot.shown = true
      while (true) {
        const chunk = Buffer.allocUnsafe(65536)
        const size = readSync(slot.output, chunk, 0, chunk.length, slot.printed)
        if (size === 0) break
        out(chunk.subarray(0, size))
        slot.printed += size
      }
      if (!slot.end) return
      closeSync(slot.output)
      out(`${slot.end.record}\n`)
    }
  }

  const live = setInterval(() => guard(print), 200)
  const finish = () => {
    clearInterval(live)
    guard(() => rmSync(folder, { recursive: true, force: true }))
    const ends = started.flatMap((slot) => (slot.end ? [slot.end] : []))
    const first = ends.find((end) => end.failed)
    const outcome = {
      results: ends.map((end) => end.result),
      code: first ? first.result.exitCode || 1 : 0,
    }
    const settle = () => {
      process.stdout.off('error', refuse)
      if (fault) reject(fault.error)
      else resolve(outcome)
    }
    if (unanswered === 0) settle()
    else answered = settle
  }
  const launch = () => {
    const task = tasks[started.length]
    const path = join(folder, `${started.length}.log`)
    const opened: number[] = []
    const registered = guard(() => {
      const sink = openSync(path, 'a')
      opened.push(sink)
      const output = openSync(path, 'r')
      opened.push(output)
      const slot: Slot = { task, output, printed: 0, shown: false }
      const began = performance.now()
      const child = spawn(process.execPath, ['run', task], {
        cwd: root,
        stdio: ['ignore', sink, sink],
      })
      const ended = (status: number | null, abnormal: boolean) => {
        if (slot.end) return
        slot.end = taskEnd(task, began, status, abnormal)
        running -= 1
        failed ||= slot.end.failed
        guard(print)
        start()
      }
      child.on('error', () => ended(null, true))
      child.on('exit', (status, signal) => ended(status, !!signal))
      started.push(slot)
      running += 1
    })
    // The task holds a write end of its own; a file without a task has no reader either.
    const [sink, output] = opened
    if (sink !== undefined) guard(() => closeSync(sink))
    if (!registered && output !== undefined) guard(() => closeSync(output))
  }
  const start = () => {
    while (!(fault || failed) && running < limit && started.length < tasks.length) launch()
    if (running === 0) finish()
  }
  start()
  return promise
}
