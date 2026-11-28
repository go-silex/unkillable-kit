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
 * its two streams stay in the order it wrote them. What it left running is not printed after that.
 *
 * Rejects, once the running tasks ended, when a task cannot be given its file or its process, and
 * when stdout refuses the log: the caller gets no results for a run it could not carry out or show.
 */
export function runTogether(root: string, tasks: string[], limit: number): Promise<Outcome> {
  const { promise, resolve, reject } = Promise.withResolvers<Outcome>()
  const folder = mkdtempSync(join(tmpdir(), 'root-gate-output-'))
  const started: Slot[] = []
  let running = 0
  let failed = false
  let fault: { error: unknown } | undefined
  let head = 0
  let sent: Promise<Error | null | undefined> = Promise.resolve(undefined)

  // Only process.stdout.write: on a pipe, console.log would overtake what it has not flushed.
  // `sent` settles when stdout has taken the last write, with the error if it refused it.
  const out = (data: string | Uint8Array) => {
    const taken = Promise.withResolvers<Error | null | undefined>()
    process.stdout.write(data, taken.resolve)
    sent = taken.promise
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

  const live = setInterval(print, 200)
  const finish = () => {
    clearInterval(live)
    rmSync(folder, { recursive: true, force: true })
    if (fault) return reject(fault.error)
    const ends = started.flatMap((slot) => (slot.end ? [slot.end] : []))
    const first = ends.find((end) => end.failed)
    const outcome = {
      results: ends.map((end) => end.result),
      code: first ? first.result.exitCode || 1 : 0,
    }
    sent.then((error) => (error ? reject(error) : resolve(outcome)))
  }
  const launch = () => {
    const task = tasks[started.length]
    const path = join(folder, `${started.length}.log`)
    let sink: number | undefined
    let output: number | undefined
    try {
      sink = openSync(path, 'a')
      output = openSync(path, 'r')
      const slot: Slot = { task, output, printed: 0, shown: false }
      const began = performance.now()
      const child = spawn(process.execPath, ['run', task], {
        cwd: root,
        stdio: ['ignore', sink, sink],
      })
      const settle = (status: number | null, abnormal: boolean) => {
        if (slot.end) return
        slot.end = taskEnd(task, began, status, abnormal)
        running -= 1
        failed ||= slot.end.failed
        print()
        start()
      }
      child.on('error', () => settle(null, true))
      child.on('exit', (status, signal) => settle(status, !!signal))
      started.push(slot)
      running += 1
    } catch (error) {
      if (output !== undefined) closeSync(output)
      fault = { error }
    } finally {
      if (sink !== undefined) closeSync(sink)
    }
  }
  const start = () => {
    while (!(fault || failed) && running < limit && started.length < tasks.length) launch()
    if (running === 0) finish()
  }
  start()
  return promise
}
