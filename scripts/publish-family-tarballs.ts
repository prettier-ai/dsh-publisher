/**
 * Publish every packed tarball in a directory, with a conflict policy.
 *
 * Official `release:publish` aborts the whole family when a name@version is
 * already on npm with different bytes. Vendor packages keep their own versions
 * across official tags; npm cannot overwrite, so Sync would never reach the
 * new dsh family (Actions run 33638213440: `@prettier-ai/cordis-plugin-hmr@1.0.17`).
 *
 * `--on-conflict skip` (Sync vendor and dsh families): skip matching and
 * mismatched already-published tarballs; publish only absences.
 * `--on-conflict fail`: skip matching integrity; fail on mismatch (kept for
 * tests; Pack CLI uses the stricter CLI publisher).
 *
 * Does not call `pnpm run`, so pnpm 11 cannot `pnpm install --production`
 * before the script.
 *
 * Usage:
 *   node --experimental-strip-types scripts/publish-family-tarballs.ts --from dist/npm-vendor --on-conflict skip
 *   node --experimental-strip-types scripts/publish-family-tarballs.ts --from dist/npm --on-conflict skip
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  npmPublishDistTag,
  readRegistryIntegrity,
  tarballIntegrity,
  type RegistryIntegrity,
  type TarballPublishIo,
} from './publish-cli-tarball.ts'

/** How to treat a registry tarball whose integrity differs from the local file. */
export type FamilyConflictPolicy = 'skip' | 'fail'

/** One packed `.tgz` and the name/version it declares. */
export interface FamilyPackedTarball {
  readonly name: string
  readonly version: string
  readonly file: string
}

/**
 * What to do with one local tarball given the registry and conflict policy.
 * `skip` carries why, so the publisher can log match vs reuse-without-bump.
 */
export type FamilyPublishDecision =
  | { readonly kind: 'publish' }
  | { readonly kind: 'skip'; readonly reason: 'match' | 'conflict' }
  | { readonly kind: 'conflict' }

/** Injected I/O; tests replace fetch, publish, and sleep. */
export interface FamilyPublishIo extends TarballPublishIo {
  readonly sleep?: (ms: number) => Promise<void>
}

const TRANSIENT_PUBLISH_CODES = [
  'E409',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
] as const

const PUBLISH_ATTEMPTS = 4
const PUBLISH_SPACING_MS = 2_000
/** GET after `npm publish` can 404 while npm is still processing the packument. */
const REGISTRY_VISIBLE_ATTEMPTS = 15

/**
 * Decide whether one packed tarball may be published.
 * @param args.localIntegrity - `sha512-…` of the packed file.
 * @param args.registry - current registry state for that name@version.
 * @param args.onConflict - vendor skip vs dsh-family fail.
 */
export function decideFamilyTarballPublish(args: {
  readonly localIntegrity: string
  readonly registry: RegistryIntegrity
  readonly onConflict: FamilyConflictPolicy
}): FamilyPublishDecision {
  if (args.registry.kind === 'absent') return { kind: 'publish' }
  if (args.registry.integrity === args.localIntegrity) {
    return { kind: 'skip', reason: 'match' }
  }
  if (args.onConflict === 'skip') return { kind: 'skip', reason: 'conflict' }
  return { kind: 'conflict' }
}

/**
 * Operator-facing error when the dsh family hits an immutable version clash.
 * @param name - package name.
 * @param version - exact version.
 */
export function familyPublishConflictMessage(name: string, version: string): string {
  return (
    `${name}@${version} is already published with different content. `
    + 'This republisher cannot overwrite an immutable npm version. '
    + 'Vendor packages reused across official tags should use --on-conflict skip. '
    + 'The tarball from this run remains on the workflow artifacts.'
  )
}

/**
 * List packed tarballs in filename order.
 * @param directory - directory of `.tgz` files.
 */
export function listPackedTarballs(directory: string): readonly FamilyPackedTarball[] {
  if (!existsSync(directory)) {
    throw new Error(`publish-family-tarballs: ${directory} does not exist`)
  }
  const found: FamilyPackedTarball[] = []
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
    const file = join(directory, filename)
    const identity = readPackedIdentity(file)
    found.push({ ...identity, file })
  }
  if (found.length === 0) {
    throw new Error(`publish-family-tarballs: no tarballs in ${directory}`)
  }
  return found
}

/**
 * Skip, refuse, or publish each tarball, then re-fetch after each write.
 * @param directory - directory of packed `.tgz` files.
 * @param onConflict - skip reused vendor versions, or fail the dsh family.
 * @param io - optional fetch/publish/sleep substitutes for tests.
 */
export async function publishPackedFamily(
  directory: string,
  onConflict: FamilyConflictPolicy,
  io: FamilyPublishIo = {},
): Promise<void> {
  const fetchImpl = io.fetchImpl ?? fetch
  const publish = io.publish
  const sleep = io.sleep ?? sleepMs
  const packed = listPackedTarballs(directory)
  const total = String(packed.length)
  let published = 0
  let skipped = 0
  for (const [index, tarball] of packed.entries()) {
    const progress = `[${String(index + 1)}/${total}]`
    const local = tarballIntegrity(tarball.file)
    const registry = await readRegistryIntegrity(tarball.name, tarball.version, fetchImpl)
    const decision = decideFamilyTarballPublish({
      localIntegrity: local,
      registry,
      onConflict,
    })
    if (decision.kind === 'skip') {
      const why = decision.reason === 'match'
        ? 'already published with matching integrity, skipping'
        : 'already published with different content, skipping'
      console.log(`publish-family: ${progress} ${tarball.name}@${tarball.version} ${why}`)
      skipped += 1
      continue
    }
    if (decision.kind === 'conflict') {
      throw new Error(familyPublishConflictMessage(tarball.name, tarball.version))
    }
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    if (publish !== undefined) {
      publish(tarball.file, tarball.version)
    } else {
      await publishNpmTarballWithRetry(tarball.file, tarball.version, tarball.name, fetchImpl, sleep)
    }
    const visible = await waitForRegistryVersion(tarball.name, tarball.version, fetchImpl, sleep)
    if (!visible) {
      console.log(
        `publish-family: ${progress} ${tarball.name}@${tarball.version} published; `
        + 'registry GET still 404, continuing (Actions run 33691258894)',
      )
    } else {
      console.log(`publish-family: ${progress} ${tarball.name}@${tarball.version} published`)
    }
    published += 1
  }
  console.log(
    `publish-family: ${total} member(s), ${String(published)} published, ${String(skipped)} already present`,
  )
}

async function waitForRegistryVersion(
  name: string,
  version: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let tries = 1; tries <= REGISTRY_VISIBLE_ATTEMPTS; tries += 1) {
    const registry = await readRegistryIntegrity(name, version, fetchImpl)
    if (registry.kind === 'present') return true
    if (tries === REGISTRY_VISIBLE_ATTEMPTS) return false
    if (tries === 1) {
      console.log(`publish-family: ${name}@${version} not visible yet, waiting for the registry`)
    }
    await sleep(PUBLISH_SPACING_MS)
  }
  return false
}

function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

async function publishNpmTarballWithRetry(
  tarball: string,
  version: string,
  name: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const tagArgs = npmPublishDistTag(version) === 'next' ? ['--tag', 'next'] : []
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    const result = spawnSync('npm', ['publish', tarball, ...tagArgs], { encoding: 'utf8' })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (output !== '') process.stdout.write(output)
    if (result.error !== undefined) {
      throw new Error(`npm publish ${tarball} failed: ${result.error.message}`)
    }
    if (result.status === 0) return
    const settled = await readRegistryIntegrity(name, version, fetchImpl)
    if (settled.kind === 'present' && settled.integrity === tarballIntegrity(tarball)) {
      console.log(`publish-family: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `publish-family: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
  throw new Error(`npm publish ${name}@${version} failed: retry loop exhausted`)
}

function readPackedIdentity(tarball: string): { name: string; version: string } {
  const raw = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' })
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${tarball} package/package.json is not a JSON object`)
  }
  if (!('name' in parsed) || !('version' in parsed)) {
    throw new Error(`${tarball} manifest lacks name/version`)
  }
  const { name, version } = parsed
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error(`${tarball} manifest lacks name/version`)
  }
  return { name, version }
}

function parseConflictPolicy(value: string | undefined): FamilyConflictPolicy {
  if (value === 'skip' || value === 'fail') return value
  throw new Error('publish-family-tarballs: --on-conflict skip|fail is required')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      'on-conflict': { type: 'string' },
    },
    allowPositionals: false,
  })
  const from = values.from
  if (from === undefined || from === '') {
    throw new Error('publish-family-tarballs: --from <packed directory> is required')
  }
  await publishPackedFamily(from, parseConflictPolicy(values['on-conflict']))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
