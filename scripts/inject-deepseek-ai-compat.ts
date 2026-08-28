/**
 * Host-side `@deepseek-ai/*` compatibility for packed `@prettier-ai/dsh`.
 *
 * After `rescope-to-prettier-ai --apply` and `release:pack`, this rewrite is
 * applied to the packed CLI tarball (not to the workspace before `pnpm
 * install`, which would make CI fetch unpublished `@deepseek-ai/*` names).
 *
 * Investigation of official `apps/cli` (deepseek-harness `dsh-v0.1.2-alpha.1`):
 * - The only published bin is `apps/cli` `dsh` → `lib/bin.js`. `headless` /
 *   `web` are profiles (`PROFILE_TEMPLATES`), not packages with bins.
 * - `bin.ts` statically imports `@deepseek-ai/dsh-app-boot` (rescoped to
 *   `@prettier-ai/*`) then dynamically imports `profile-boot`, which loads
 *   plugins from `$DSH_HOME/profiles/<name>` through cordis-plugin-loader
 *   `import(name)`.
 * - A profile plugin's resolve walk does not include the global CLI
 *   `node_modules`, so package.json aliases alone cannot rewrite specifiers
 *   inside plugin source. Hypothesis discarded: patching `apps/cli/src/bin.ts`
 *   before tsdown. The CLI bundles `lib/types/bin.js` → `lib/bin.js`, and this
 *   overlay must not vendor Harness sources. Wrapping the packed bin is the
 *   site we control.
 *
 * Two layers:
 * 1. Runtime (required): a Node module hook registered from the CLI bin so
 *    `import '@deepseek-ai/cordis'` (and every other `@deepseek-ai/*`
 *    specifier) resolves to `@prettier-ai/cordis` from this installation.
 * 2. Install-time: npm aliases `@deepseek-ai/<name>` →
 *    `npm:@prettier-ai/<name>@<same range>` on each `@prettier-ai/*`
 *    dependency, so `healProfilesModuleFallback` and `resolve.paths` still
 *    find physical `@deepseek-ai/*` directories for existing profile manifests.
 *
 * The published CLI bin name stays `dsh`. This overlay wraps the file at
 * `lib/bin.js`; it does not rename `bin.dsh` in package.json.
 *
 * Usage: `node --experimental-strip-types scripts/inject-deepseek-ai-compat.ts
 * [--apply|--check --applied] --from dist/npm`
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const FROM_SCOPE = '@deepseek-ai/'
const TO_SCOPE = '@prettier-ai/'
const ENTRY_PACKAGE = '@prettier-ai/dsh'
const COMPAT_MARKER = 'prettier-ai:deepseek-ai-compat'
const LOADER_FILENAME = 'deepseek-ai-compat-loader.js'
const INSTALL_SECTIONS = ['dependencies', 'optionalDependencies'] as const
const PUBLISHED_CLI_BIN = 'dsh'
const PUBLISHED_CLI_BIN_PATH = 'lib/bin.js'

/** Marker comment written into the wrapped CLI bin. Exported for tests. */
export const DEEPSEEK_AI_COMPAT_MARKER = COMPAT_MARKER

/**
 * Map one import/require specifier from the official scope to this release.
 * Scope-only: `@deepseek-ai/cordis` → `@prettier-ai/cordis`, including subpaths.
 * @param specifier - a Node package specifier, URL, or relative path.
 * @returns The `@prettier-ai/` specifier, or `undefined` when this is not an
 *   official-scope package name.
 */
export function mapDeepseekAiSpecifier(specifier: string): string | undefined {
  if (!specifier.startsWith(FROM_SCOPE)) return undefined
  return `${TO_SCOPE}${specifier.slice(FROM_SCOPE.length)}`
}

/**
 * npm alias spec for one `@prettier-ai/*` dependency at the same range.
 * @param prettierAiName - for example `@prettier-ai/cordis`.
 * @param range - the packed range, copied verbatim.
 * @returns `npm:@prettier-ai/cordis@<range>`.
 */
export function npmAliasFor(prettierAiName: string, range: string): string {
  return `npm:${prettierAiName}@${range}`
}

/**
 * Build `@deepseek-ai/<name>` aliases for each `@prettier-ai/*` dependency.
 * @param dependencies - one manifest dependency section.
 * @returns Alias names to `npm:@prettier-ai/<name>@<same range>`.
 */
export function deepseekAiAliasesFor(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (!name.startsWith(TO_SCOPE)) continue
    const aliasName = `${FROM_SCOPE}${name.slice(TO_SCOPE.length)}`
    if (aliasName === name) continue
    aliases[aliasName] = npmAliasFor(name, range)
  }
  return aliases
}

interface PackedManifest {
  name?: unknown
  bin?: unknown
  dependencies?: unknown
  optionalDependencies?: unknown
  [key: string]: unknown
}

/**
 * Whether a packed manifest is a published app entry that loads profile plugins.
 * Official headless/web are profiles, not bins; `@prettier-ai/dsh` is the
 * known entry, and any future bin that depends on `@prettier-ai/*` is included.
 * @param manifest - parsed package.json.
 */
export function isPluginLoadingApp(manifest: PackedManifest): boolean {
  if (manifest.name === ENTRY_PACKAGE) return true
  if (binRelPaths(manifest).length === 0) return false
  for (const section of INSTALL_SECTIONS) {
    const deps = stringRecord(manifest[section])
    if (Object.keys(deps).some(name => name.startsWith(TO_SCOPE))) return true
  }
  return false
}

/**
 * Merge install-time `@deepseek-ai/*` aliases into one dependency section.
 * Idempotent: already-correct aliases are left unchanged.
 * @param dependencies - existing section, or undefined.
 * @returns The merged section and whether anything changed.
 */
export function mergeDeepseekAiAliases(
  dependencies: Readonly<Record<string, string>> | undefined,
): { readonly deps: Record<string, string>; readonly changed: boolean } {
  const deps: Record<string, string> = { ...(dependencies ?? {}) }
  const aliases = deepseekAiAliasesFor(deps)
  let changed = false
  for (const [aliasName, spec] of Object.entries(aliases)) {
    if (deps[aliasName] === spec) continue
    deps[aliasName] = spec
    changed = true
  }
  return { deps, changed }
}

/** Result of injecting one unpacked package directory. */
export interface InjectPackageResult {
  readonly changed: boolean
  readonly wrappedBins: readonly string[]
}

/**
 * Inject aliases and the runtime hook into one unpacked `package/` directory.
 * @param packageDir - directory that contains package.json.
 * @returns Whether files changed and which bins were wrapped.
 */
export function injectPackageDir(packageDir: string): InjectPackageResult {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = readManifest(manifestPath)
  if (!isPluginLoadingApp(manifest)) {
    return { changed: false, wrappedBins: [] }
  }
  let changed = false
  for (const section of INSTALL_SECTIONS) {
    const current = stringRecord(manifest[section])
    if (Object.keys(current).length === 0 && manifest[section] === undefined) continue
    const merged = mergeDeepseekAiAliases(Object.keys(current).length === 0 ? undefined : current)
    if (!merged.changed) continue
    manifest[section] = merged.deps
    changed = true
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const wrappedBins: string[] = []
  for (const relPath of binRelPaths(manifest)) {
    if (wrapBin(packageDir, relPath)) {
      wrappedBins.push(relPath)
      changed = true
    }
  }
  return { changed, wrappedBins }
}

/**
 * Inject compatibility into one packed tarball, rewriting it in place when needed.
 * @param tarball - path to a `.tgz`.
 * @returns True when the archive was rewritten.
 */
export function injectTarball(tarball: string): boolean {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deepseek-ai-compat-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', tmp])
    const packageDir = join(tmp, 'package')
    if (!existsSync(join(packageDir, 'package.json'))) {
      throw new Error(`${tarball} has no package/package.json`)
    }
    const result = injectPackageDir(packageDir)
    if (!result.changed) return false
    const tmpOut = `${tarball}.compat-tmp`
    execFileSync('tar', ['-czf', tmpOut, '-C', tmp, 'package'])
    renameSync(tmpOut, tarball)
    return true
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** One packed directory's inject pass. */
export interface InjectDirectoryResult {
  readonly injected: readonly string[]
  readonly skipped: readonly string[]
}

/**
 * Inject every plugin-loading app tarball in a pack output directory.
 * Non-app tarballs are peeked and left byte-identical.
 * @param directory - `dist/npm` (or a test fixture).
 * @param apply - when false, report without writing.
 */
export function injectPackedDirectory(directory: string, apply: boolean): InjectDirectoryResult {
  const tarballs = listTarballs(directory)
  const injected: string[] = []
  const skipped: string[] = []
  for (const filename of tarballs) {
    const tarball = join(directory, filename)
    const manifest = readPackedManifest(tarball)
    if (!isPluginLoadingApp(manifest)) {
      skipped.push(filename)
      continue
    }
    if (apply) injectTarball(tarball)
    injected.push(filename)
  }
  return { injected, skipped }
}

/**
 * Assert packed app tarballs already carry aliases and the wrapped bin.
 * @param directory - pack output directory.
 * @throws When no app tarball is present or injection is missing.
 */
export function checkAppliedCompat(directory: string): void {
  const tarballs = listTarballs(directory)
  const failures: string[] = []
  let apps = 0
  for (const filename of tarballs) {
    const tarball = join(directory, filename)
    const manifest = readPackedManifest(tarball)
    if (!isPluginLoadingApp(manifest)) continue
    apps += 1
    failures.push(...checkPackedApp(tarball, filename, manifest))
  }
  if (apps === 0) {
    failures.push('no plugin-loading app tarball (expected @prettier-ai/dsh or a bin that depends on @prettier-ai/*)')
  }
  if (failures.length > 0) {
    throw new Error(`inject-deepseek-ai-compat: ${String(failures.length)} problem(s)\n${failures.join('\n')}`)
  }
}

function checkPackedApp(tarball: string, filename: string, manifest: PackedManifest): string[] {
  const failures: string[] = []
  failures.push(...checkPublishedCliBin(filename, manifest))
  for (const section of INSTALL_SECTIONS) {
    const deps = stringRecord(manifest[section])
    const aliases = deepseekAiAliasesFor(deps)
    for (const [aliasName, spec] of Object.entries(aliases)) {
      if (deps[aliasName] === spec) continue
      failures.push(
        `${filename}: ${section} missing alias ${aliasName} → ${spec}`
        + (deps[aliasName] === undefined ? '' : ` (have ${JSON.stringify(deps[aliasName])})`),
      )
    }
  }
  for (const relPath of binRelPaths(manifest)) {
    const packedBin = `package/${relPath.replaceAll('\\', '/')}`
    if (!tarballHasMember(tarball, packedBin)) {
      failures.push(`${filename}: missing bin ${packedBin}`)
      continue
    }
    const body = execFileSync('tar', ['-xOzf', tarball, packedBin], { encoding: 'utf8' })
    if (!body.includes(COMPAT_MARKER)) {
      failures.push(`${filename}: ${relPath} is not the compatibility wrapper`)
    }
    if (body.includes('async function resolveMapped')) {
      failures.push(
        `${filename}: ${relPath} registerHooks resolve must be synchronous `
        + '(Node 24 resolveSync rejects a Promise url)',
      )
    }
    const inner = innerBinRelPath(relPath)
    if (!tarballHasMember(tarball, `package/${inner.replaceAll('\\', '/')}`)) {
      failures.push(`${filename}: missing wrapped upstream bin package/${inner}`)
    }
    const loader = join(dirname(relPath), LOADER_FILENAME).replaceAll('\\', '/')
    if (!tarballHasMember(tarball, `package/${loader}`)) {
      failures.push(`${filename}: missing ${loader}`)
    }
  }
  return failures
}

/**
 * `@prettier-ai/dsh` keeps the upstream `dsh` bin. Compatibility wraps the
 * file at `lib/bin.js`; it must not rename the published command.
 */
function checkPublishedCliBin(filename: string, manifest: PackedManifest): string[] {
  if (manifest.name !== ENTRY_PACKAGE) return []
  const failures: string[] = []
  const bin = manifest.bin
  if (typeof bin === 'string') {
    if (bin !== PUBLISHED_CLI_BIN_PATH) {
      failures.push(
        `${filename}: @prettier-ai/dsh string bin is ${JSON.stringify(bin)}, expected ${JSON.stringify(PUBLISHED_CLI_BIN_PATH)}`,
      )
    }
    return failures
  }
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
    failures.push(`${filename}: @prettier-ai/dsh is missing bin.${PUBLISHED_CLI_BIN}`)
    return failures
  }
  const record = bin as Record<string, unknown>
  if (record[PUBLISHED_CLI_BIN] !== PUBLISHED_CLI_BIN_PATH) {
    failures.push(
      `${filename}: @prettier-ai/dsh bin.${PUBLISHED_CLI_BIN} is ${JSON.stringify(record[PUBLISHED_CLI_BIN])}, expected ${JSON.stringify(PUBLISHED_CLI_BIN_PATH)}`,
    )
  }
  if ('dshp' in record) {
    failures.push(`${filename}: @prettier-ai/dsh must not publish a dshp bin`)
  }
  return failures
}

function wrapBin(packageDir: string, relPath: string): boolean {
  const binPath = join(packageDir, relPath)
  if (!existsSync(binPath)) {
    throw new Error(`${binPath} is declared as bin but is missing`)
  }
  const current = readFileSync(binPath, 'utf8')
  if (current.includes(COMPAT_MARKER)) return false
  const innerRel = innerBinRelPath(relPath)
  const innerPath = join(packageDir, innerRel)
  if (existsSync(innerPath)) {
    throw new Error(`${innerPath} already exists; cannot wrap ${relPath}`)
  }
  renameSync(binPath, innerPath)
  const innerSpecifier = `./${basename(innerRel)}`
  writeFileSync(binPath, wrapperSource(innerSpecifier))
  chmodSync(binPath, 0o755)
  const loaderPath = join(dirname(binPath), LOADER_FILENAME)
  writeFileSync(loaderPath, loaderSource())
  return true
}

function innerBinRelPath(relPath: string): string {
  const file = basename(relPath)
  const dot = file.lastIndexOf('.')
  const inner = dot === -1 ? `${file}.upstream` : `${file.slice(0, dot)}.upstream${file.slice(dot)}`
  return join(dirname(relPath), inner)
}

function wrapperSource(innerSpecifier: string): string {
  return `#!/usr/bin/env node
/* ${COMPAT_MARKER} */
import * as nodeModule from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

const FROM = ${JSON.stringify(FROM_SCOPE)}
const TO = ${JSON.stringify(TO_SCOPE)}

function mapSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith(FROM)) return undefined
  return TO + specifier.slice(FROM.length)
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function pathIsInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function parentIsUnderProfiles(parentURL) {
  if (typeof parentURL !== 'string' || parentURL === '') return false
  let path
  try {
    path = fileURLToPath(parentURL)
  } catch {
    return false
  }
  return pathIsInside(join(resolveDshHome(), 'profiles'), path)
}

function profileParentURLs() {
  const profilesDir = join(resolveDshHome(), 'profiles')
  const urls = []
  let names
  try {
    names = readdirSync(profilesDir)
  } catch {
    return urls
  }
  for (const name of names) {
    if (name === 'node_modules' || name === '.' || name === '..') continue
    const pkg = join(profilesDir, name, 'package.json')
    if (existsSync(pkg)) urls.push(pathToFileURL(pkg).href)
  }
  return urls
}

function findInstallRoot(fromUrl) {
  let dir = dirname(fileURLToPath(fromUrl))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('dsh: cannot find package.json above the CLI bin for @deepseek-ai/* compatibility')
    }
    dir = parent
  }
}

function isBarePackageSpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('node:')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false
  return true
}

function shouldResolveFromProfile(specifier, parentURL) {
  if (!isBarePackageSpecifier(specifier)) return false
  if (specifier === TO.slice(0, -1) || specifier.startsWith(TO)) return false
  if (parentIsUnderProfiles(parentURL)) return false
  return true
}

function resolveMapped(specifier, context, nextResolve, cliParentURL) {
  const mapped = mapSpecifier(specifier)
  if (mapped !== undefined) {
    try {
      // Must stay synchronous: Node 24 registerHooks runs from resolveSync.
      // Returning a Promise makes url undefined (ERR_INVALID_RETURN_PROPERTY_VALUE).
      return nextResolve(mapped, { ...context, parentURL: cliParentURL })
    } catch {
      return nextResolve(specifier, context)
    }
  }
  // Official: profile node_modules first, then the rest. Do not remap
  // dshmarket, @dsh-ssh/*, @aaravarr/*, or dsh-subagent-sidebar.
  if (shouldResolveFromProfile(specifier, context.parentURL)) {
    for (const parentURL of profileParentURLs()) {
      try {
        return nextResolve(specifier, { ...context, parentURL })
      } catch {
        // try the next profile directory
      }
    }
  }
  return nextResolve(specifier, context)
}

async function registerCompat() {
  const cliParentURL = pathToFileURL(join(findInstallRoot(import.meta.url), 'package.json')).href
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        return resolveMapped(specifier, context, nextResolve, cliParentURL)
      },
    })
    return
  }
  if (typeof nodeModule.register !== 'function') {
    throw new Error('dsh: Node module register hooks are required for @deepseek-ai/* compatibility')
  }
  const { port1, port2 } = new MessageChannel()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('dsh: timed out registering @deepseek-ai/* compatibility hooks'))
    }, 5000)
    port1.once('message', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
  nodeModule.register(new URL(${JSON.stringify(`./${LOADER_FILENAME}`)}, import.meta.url).href, import.meta.url, {
    data: { port: port2, cliParentURL },
    transferList: [port2],
  })
  await ready
  port1.close()
}

await registerCompat()
await import(${JSON.stringify(innerSpecifier)})
`
}

function loaderSource(): string {
  return `import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FROM = ${JSON.stringify(FROM_SCOPE)}
const TO = ${JSON.stringify(TO_SCOPE)}

let cliParentURL = ''

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function pathIsInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function parentIsUnderProfiles(parentURL) {
  if (typeof parentURL !== 'string' || parentURL === '') return false
  let path
  try {
    path = fileURLToPath(parentURL)
  } catch {
    return false
  }
  return pathIsInside(join(resolveDshHome(), 'profiles'), path)
}

function profileParentURLs() {
  const profilesDir = join(resolveDshHome(), 'profiles')
  const urls = []
  let names
  try {
    names = readdirSync(profilesDir)
  } catch {
    return urls
  }
  for (const name of names) {
    if (name === 'node_modules' || name === '.' || name === '..') continue
    const pkg = join(profilesDir, name, 'package.json')
    if (existsSync(pkg)) urls.push(pathToFileURL(pkg).href)
  }
  return urls
}

export async function initialize(data) {
  if (data !== null && typeof data === 'object' && 'cliParentURL' in data && typeof data.cliParentURL === 'string') {
    cliParentURL = data.cliParentURL
  }
  if (data !== null && typeof data === 'object' && data.port !== undefined && data.port !== null) {
    data.port.postMessage('ready')
  }
}

function isBarePackageSpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('node:')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false
  return true
}

function shouldResolveFromProfile(specifier, parentURL) {
  if (!isBarePackageSpecifier(specifier)) return false
  if (specifier === TO.slice(0, -1) || specifier.startsWith(TO)) return false
  if (parentIsUnderProfiles(parentURL)) return false
  return true
}

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === 'string' && specifier.startsWith(FROM)) {
    const mapped = TO + specifier.slice(FROM.length)
    try {
      return await nextResolve(mapped, { ...context, parentURL: cliParentURL || context.parentURL })
    } catch {
      return nextResolve(specifier, context)
    }
  }
  if (shouldResolveFromProfile(specifier, context.parentURL)) {
    for (const parentURL of profileParentURLs()) {
      try {
        return await nextResolve(specifier, { ...context, parentURL })
      } catch {
        // try the next profile directory
      }
    }
  }
  return nextResolve(specifier, context)
}
`
}

function binRelPaths(manifest: PackedManifest): string[] {
  const bin = manifest.bin
  if (typeof bin === 'string' && bin !== '') return [bin]
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return []
  return Object.values(bin).filter((value): value is string => typeof value === 'string' && value !== '')
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') record[key] = entry
  }
  return record
}

function readManifest(path: string): PackedManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as PackedManifest
}

function readPackedManifest(tarball: string): PackedManifest {
  const raw = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' })
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${tarball} package/package.json is not a JSON object`)
  }
  return parsed as PackedManifest
}

/**
 * Whether a packed tarball contains one exact member path.
 * Looks up that member only; a full `tar -tzf` of bundled `node_modules`
 * exceeds Node's 1 MiB spawnSync maxBuffer (`ENOBUFS`) on official tags.
 * @param tarball - path to a `.tgz`.
 * @param member - archive member, for example `package/lib/bin.js`.
 */
function tarballHasMember(tarball: string, member: string): boolean {
  const result = spawnSync('tar', ['-tzf', tarball, member], {
    encoding: 'utf8',
    maxBuffer: 65536,
  })
  if (result.status !== 0) return false
  return (result.stdout ?? '').split('\n').includes(member)
}

function listTarballs(directory: string): string[] {
  if (!existsSync(directory)) {
    throw new Error(`inject-deepseek-ai-compat: ${directory} does not exist`)
  }
  return readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
}

function main(): void {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      applied: { type: 'boolean', default: false },
      from: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.apply === true && values.check === true) {
    throw new Error('inject-deepseek-ai-compat: use only one of --apply or --check')
  }
  if (values.applied === true && values.check !== true) {
    throw new Error('inject-deepseek-ai-compat: --applied is only valid with --check')
  }
  const from = values.from
  if (from === undefined || from === '') {
    throw new Error('inject-deepseek-ai-compat: --from <packed directory> is required')
  }
  if (values.check === true) {
    if (values.applied === true) {
      checkAppliedCompat(from)
      console.log('inject-deepseek-ai-compat: applied post-state verified — CLI tarball has aliases and the runtime hook.')
    } else {
      throw new Error('inject-deepseek-ai-compat: --check requires --applied')
    }
    return
  }
  const result = injectPackedDirectory(from, values.apply === true)
  const mode = values.apply === true ? 'apply' : 'dry'
  console.log(
    `inject-deepseek-ai-compat: ${mode} over ${from}, `
    + `${String(result.injected.length)} app tarball(s) ${values.apply === true ? 'injected' : 'would inject'}, `
    + `${String(result.skipped.length)} skipped`,
  )
  for (const file of result.injected) console.log(`  ${file}`)
  if (values.apply !== true && result.injected.length > 0) {
    console.log('inject-deepseek-ai-compat: re-run with --apply to write.')
  }
  if (values.apply === true && result.injected.length === 0) {
    throw new Error('inject-deepseek-ai-compat: no plugin-loading app tarball found to inject')
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
