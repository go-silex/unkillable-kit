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
 * Runs the tasks `limit` at a time, started in recipe order. After a failure no task starts and
 * the running ones end first. `results` lists the started tasks in recipe order.
 *
 * Each task writes to a file of its own, so the log keeps one block per task, in recipe order:
 * the earliest unfinished task is printed as it goes, a later one once those before it ended.
 * A file rather than a pipe: a task ends when its process exits, whatever it left running, and
 * its two streams stay in the order it wrote them.
 */
export function runTogether(root: string, tasks: string[], limit: number): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>()
  const folder = mkdtempSync(join(tmpdir(), 'root-gate-output-'))
  const started: Slot[] = []
  let running = 0
  let failed = false
  let head = 0

  // Only process.stdout.write: on a pipe, console.log would overtake what it has not flushed.
  const print = () => {
    for (; head < started.length; head += 1) {
      const slot = started[head]
      if (!slot.shown) process.stdout.write(`root-gate: running ${slot.task}\n`)
      slot.shown = true
      while (true) {
        const chunk = Buffer.allocUnsafe(65536)
        const size = readSync(slot.output, chunk, 0, chunk.length, slot.printed)
        if (size === 0) break
        process.stdout.write(chunk.subarray(0, size))
        slot.printed += size
      }
      if (!slot.end) return
      closeSync(slot.output)
      process.stdout.write(`${slot.end.record}\n`)
    }
  }

  const live = setInterval(print, 200)
  const finish = () => {
    clearInterval(live)
    rmSync(folder, { recursive: true, force: true })
    const ends = started.flatMap((slot) => (slot.end ? [slot.end] : []))
    const first = ends.find((end) => end.failed)
    resolve({
      results: ends.map((end) => end.result),
      code: first ? first.result.exitCode || 1 : 0,
    })
  }
  const start = () => {
    while (!failed && running < limit && started.length < tasks.length) {
      const task = tasks[started.length]
      const path = join(folder, `${started.length}.log`)
      const write = openSync(path, 'a')
      const slot: Slot = { task, output: openSync(path, 'r'), printed: 0, shown: false }
      started.push(slot)
      running += 1
      const began = performance.now()
      const child = spawn(process.execPath, ['run', task], {
        cwd: root,
        stdio: ['ignore', write, write],
      })
      closeSync(write)
      const settle = (status: number | null, abnormal: boolean) => {
        if (slot.end) return
        slot.end = taskEnd(task, began, status, abnormal)
        running -= 1
        failed ||= slot.end.failed
        print()
        start()
        if (running === 0) finish()
      }
      child.on('error', () => settle(null, true))
      child.on('exit', (status, signal) => settle(status, !!signal))
    }
  }
  start()
  if (running === 0) finish()
  return promise
}
