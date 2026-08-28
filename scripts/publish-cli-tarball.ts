/**
 * Publish the packed `@prettier-ai/dsh` tarball only.
 *
 * Used by the dispatch-only Pack CLI / Publish CLI workflow. It never walks a
 * release family and never calls official `release:publish --family`. If the
 * version is already on the registry, the local tarball must match the
 * published integrity: a mismatch fails instead of overwriting. Pack CLI does
 * not invent a version when npm_version and suffix are empty; dispatch with
 * npm_version (e.g. 0.1.1-rc.2-bundle.1) to publish the same official tag
 * under a new unpublished npm version without unpublishing the burned one.
 *
 * After `npm publish` (or a skip), the script re-fetches the version document.
 * HTTP 404 is a failure even if the CLI printed success. `npm publish` streams
 * stdio so a large bundled listing cannot hit spawnSync maxBuffer.
 *
 * Usage: `node --experimental-strip-types scripts/publish-cli-tarball.ts --from dist/npm-cli`
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { registryVersionUrl } from './probe-upstream-release.ts'

const ENTRY_PACKAGE = '@prettier-ai/dsh'
const USER_AGENT = 'prettier-ai-dsh-publisher'

/** Registry state for one exact package version. */
export type RegistryIntegrity =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/** What to do with a packed CLI tarball given the registry. */
export type CliPublishDecision = 'publish' | 'skip' | 'conflict'

/** Injected I/O for packing tests; production uses `fetch` and `npm publish`. */
export interface TarballPublishIo {
  readonly fetchImpl?: typeof fetch
  readonly publish?: (tarball: string, version: string) => void
}

/**
 * Decide whether one local tarball may be published.
 * @param localIntegrity - `sha512-…` of the packed file.
 * @param registry - current registry state for that name@version.
 */
export function decideCliTarballPublish(
  localIntegrity: string,
  registry: RegistryIntegrity,
): CliPublishDecision {
  if (registry.kind === 'absent') return 'publish'
  if (registry.integrity === localIntegrity) return 'skip'
  return 'conflict'
}

/**
 * Operator-facing error when the version is already on npm with different bytes.
 * Empty Pack CLI npm_version/suffix does not invent a version; use npm_version
 * for a burned registry name@version.
 * @param name - package name.
 * @param version - exact version.
 */
export function cliPublishConflictMessage(name: string, version: string): string {
  return (
    `${name}@${version} is already published with different content. `
    + 'This workflow does not invent a publisher-side version suffix when Pack CLI npm_version and suffix are empty and will not overwrite the registry tarball. '
    + 'Dispatch Pack CLI / Publish CLI with npm_version (or an operator-supplied suffix) to publish the same official tag under a new unpublished npm version, or wait for a new official tag. '
    + 'The tarball from this run remains on the workflow artifacts.'
  )
}

/**
 * Error when GET of the version document is still 404 after publish.
 * @param name - package name.
 * @param version - exact version.
 */
export function registryMissingAfterPublishMessage(name: string, version: string): string {
  return (
    `${name}@${version} is not on the registry after publish `
    + `(GET ${registryVersionUrl(name, version)} returned 404)`
  )
}

/**
 * Subresource integrity string npm records for a tarball.
 * @param tarball - absolute or relative tarball path.
 */
export function tarballIntegrity(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

interface PackedIdentity {
  readonly name: string
  readonly version: string
  readonly file: string
}

/**
 * Find the unique `@prettier-ai/dsh` tarball in a pack directory.
 * @param directory - directory of `.tgz` files.
 */
export function findCliTarball(directory: string): PackedIdentity {
  if (!existsSync(directory)) {
    throw new Error(`publish-cli-tarball: ${directory} does not exist`)
  }
  const found: PackedIdentity[] = []
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
    const file = join(directory, filename)
    const identity = readPackedIdentity(file)
    if (identity.name === ENTRY_PACKAGE) found.push({ ...identity, file })
  }
  if (found.length === 0) {
    throw new Error(`publish-cli-tarball: no ${ENTRY_PACKAGE} tarball in ${directory}`)
  }
  if (found.length > 1) {
    throw new Error(`publish-cli-tarball: multiple ${ENTRY_PACKAGE} tarballs in ${directory}`)
  }
  const cli = found[0]
  if (cli === undefined) throw new Error(`publish-cli-tarball: no ${ENTRY_PACKAGE} tarball in ${directory}`)
  return cli
}

/**
 * Read `dist.integrity` for one exact version. HTTP 404 means unpublished.
 * @param name - package name.
 * @param version - exact version.
 * @param fetchImpl - `fetch` (injected in tests).
 */
export async function readRegistryIntegrity(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryIntegrity> {
  const url = registryVersionUrl(name, version)
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  })
  if (response.status === 404) return { kind: 'absent' }
  if (!response.ok) {
    throw new Error(`${url} failed: ${String(response.status)} ${response.statusText}`)
  }
  const payload: unknown = await response.json()
  const integrity = distIntegrity(payload)
  if (integrity === undefined) {
    throw new Error(`${url} omitted dist.integrity`)
  }
  return { kind: 'present', integrity }
}

/**
 * Fail unless the exact version document exists on the registry.
 * @param name - package name.
 * @param version - exact version.
 * @param fetchImpl - `fetch` (injected in tests).
 */
export async function assertRegistryHasVersion(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const registry = await readRegistryIntegrity(name, version, fetchImpl)
  if (registry.kind === 'absent') {
    throw new Error(registryMissingAfterPublishMessage(name, version))
  }
}

/**
 * Publish one tarball with streamed stdio. Status is the only success signal.
 * @param tarball - path to the `.tgz`.
 * @param version - exact version (prereleases use `--tag next`).
 * @param extraArgs - extra `npm publish` flags, for example `--access public`.
 */
export function publishNpmTarball(
  tarball: string,
  version: string,
  extraArgs: readonly string[] = [],
): void {
  const tagArgs = version.includes('-') ? ['--tag', 'next'] : []
  const result = spawnSync('npm', ['publish', tarball, ...extraArgs, ...tagArgs], { stdio: 'inherit' })
  if (result.error !== undefined) {
    throw new Error(`npm publish ${tarball} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`npm publish ${tarball} failed: exit ${String(result.status ?? 'null')}`)
  }
}

/**
 * Skip, refuse, or publish the CLI tarball, then re-fetch the version document.
 * @param directory - directory of packed `.tgz` files.
 * @param io - optional fetch/publish substitutes for tests.
 */
export async function publishPackedCli(directory: string, io: TarballPublishIo = {}): Promise<void> {
  const fetchImpl = io.fetchImpl ?? fetch
  const publish = io.publish ?? publishNpmTarball
  const cli = findCliTarball(directory)
  const local = tarballIntegrity(cli.file)
  const registry = await readRegistryIntegrity(cli.name, cli.version, fetchImpl)
  const decision = decideCliTarballPublish(local, registry)
  if (decision === 'skip') {
    console.log(`publish-cli-tarball: ${cli.name}@${cli.version} already published with matching integrity, skipping`)
    await assertRegistryHasVersion(cli.name, cli.version, fetchImpl)
    return
  }
  if (decision === 'conflict') {
    throw new Error(cliPublishConflictMessage(cli.name, cli.version))
  }
  publish(cli.file, cli.version)
  await assertRegistryHasVersion(cli.name, cli.version, fetchImpl)
  console.log(`publish-cli-tarball: ${cli.name}@${cli.version} published`)
}

function distIntegrity(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const dist = (payload as { dist?: unknown }).dist
  if (dist === null || typeof dist !== 'object' || Array.isArray(dist)) return undefined
  const integrity = (dist as { integrity?: unknown }).integrity
  return typeof integrity === 'string' && integrity !== '' ? integrity : undefined
}

function readPackedIdentity(tarball: string): { name: string; version: string } {
  const raw = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' })
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${tarball} package/package.json is not a JSON object`)
  }
  const { name, version } = parsed as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error(`${tarball} manifest lacks name/version`)
  }
  return { name, version }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { from: { type: 'string' } },
    allowPositionals: false,
  })
  const from = values.from
  if (from === undefined || from === '') {
    throw new Error('publish-cli-tarball: --from <packed directory> is required')
  }
  await publishPackedCli(from)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
