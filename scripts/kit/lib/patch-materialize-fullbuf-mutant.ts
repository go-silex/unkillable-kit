#!/usr/bin/env bun
/** Restore a full-buffer writeExact for the paced writer self-test. */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: patch-materialize-fullbuf-mutant.ts <materialize-tree.ts>')
  process.exit(2)
}
const source = readFileSync(path, 'utf8')
const pattern = /async writeExact\(fd: number, n: number\) \{[\s\S]*?\n {4}\},/
const replacement = `async writeExact(fd: number, n: number) {
      // MUTANT: buffer the entire blob then write once (old path).
      await need(n)
      const parts: Buffer[] = []
      let left = n
      while (left > 0) {
        const head = chunks[0]!
        const available = head.length - offset
        const take = Math.min(available, left)
        parts.push(head.subarray(offset, offset + take))
        offset += take
        left -= take
        buffered -= take
        if (offset === head.length) {
          chunks.shift()
          offset = 0
        }
      }
      writeSync(fd, Buffer.concat(parts))
    },`
const next = source.replace(pattern, replacement)
if (next === source) {
  console.error('failed to patch writeExact')
  process.exit(1)
}
writeFileSync(path, next)
