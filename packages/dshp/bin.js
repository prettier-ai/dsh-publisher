#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let dshPackageJson
try {
  dshPackageJson = require.resolve('@prettier-ai/dsh/package.json')
} catch {
  console.error('dshp: cannot find @prettier-ai/dsh; install the matching version of that package')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(dshPackageJson, 'utf8'))
const bin = manifest.bin
const rel = typeof bin === 'string'
  ? bin
  : (bin !== null && typeof bin === 'object' ? bin.dsh : undefined)
if (typeof rel !== 'string' || rel === '') {
  console.error('dshp: @prettier-ai/dsh is missing bin.dsh')
  process.exit(1)
}

const result = spawnSync(process.execPath, [join(dirname(dshPackageJson), rel), ...process.argv.slice(2)], {
  stdio: 'inherit',
})
if (result.error !== undefined) {
  console.error(result.error)
  process.exit(1)
}
if (result.signal !== null) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)
