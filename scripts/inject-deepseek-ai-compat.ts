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
 * Four layers:
 * 1. Runtime (required): a Node module hook registered from the CLI bin so
 *    `import '@deepseek-ai/cordis'` resolves from this installation. Official
 *    `@deepseek-ai/*` specifiers try the physical CLI aliases first (so
 *    client-modules can match Loader entry names against package.json `name`),
 *    then the `@prettier-ai/*` copy. Host `@prettier-ai/*` specifiers also
 *    resolve from this installation. Third-party profile plugins stay in
 *    `$DSH_HOME/profiles/<name>/node_modules`. After a failed profile
 *    `nextResolve`, Node 22 `module.register` keeps `context.parentURL` on
 *    that profile; fallbacks must pass the snapshotted importer or CLI
 *    packages cannot see `zod` / `commander` in bundled `node_modules`.
 *    `registerHooks` / `module.register` do not intercept CJS
 *    `createRequire`. npm-installed profile plugins resolve through healed
 *    `$DSH_HOME/profiles/node_modules`. A local plugin (`file:`, `npm link`)
 *    realpaths outside that tree, so CJS `require('@deepseek-ai/…')` never
 *    sees the aliases. Wrap `Module._resolveFilename` so host specifiers from
 *    outside the CLI still resolve from this installation (official name first,
 *    then `@prettier-ai/*`). `dsh-client-modules` also uses
 *    `createRequire(profile).resolve` to scan `dsh.client` packages.
 * 2. Browser/plugin identity restore: rescope rewrites CLIENT_MODULES_ID,
 *    tsdown client-bundle banners, Vite seed keys, and `dsh.client.inject` to
 *    `@prettier-ai/*`. Third-party plugins still name `@deepseek-ai/*`. After
 *    pack, those wire IDs are restored so HTML parser-preloads match. The
 *    client-modules seed Map also aliases each platform key onto the other
 *    scope, and `makeRequire` / `import` retry the other scope, so
 *    `require("@deepseek-ai/dsh-client-ui-primitives")` hits a table that Vite
 *    still keyed `@prettier-ai/*`. npm package names and bundle YAML Loader
 *    `name` fields stay `@prettier-ai/*` (typert requires Loader name ===
 *    package.json `name`). The client-modules scan then emits `@deepseek-ai/*`
 *    graph row ids from those Loader names (0.1.1-rc.2 `processOne`, 0.1.2
 *    `reconcilePackage`).
 * 3. Profile fallback links: the fat CLI strips `@prettier-ai/*` from
 *    `dependencies`, so official `healProfilesModuleFallback` only links the
 *    CLI package itself. The wrapper also symlinks every bundled
 *    `@prettier-ai/*` and `@deepseek-ai/*` into `$DSH_HOME/profiles/node_modules`
 *    so CJS resolve from the profile can see host plugins.
 * 4. Install-time: npm aliases `@deepseek-ai/<name>` →
 *    `npm:@prettier-ai/<name>@<same range>` on each `@prettier-ai/*`
 *    dependency when the thin graph still lists them. The fat tarball does
 *    not re-list those names.
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
import { basename, dirname, join, relative } from 'node:path'
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
 * Map a published-scope specifier back to the official plugin identity.
 * Browser boot IDs, `dsh.client.inject`, and third-party plugins still use
 * `@deepseek-ai/*`. npm package names on the `@prettier-ai` copies stay published-scope.
 * @param specifier - a Node package specifier, including subpaths.
 */
export function officialPluginIdentity(specifier: string): string {
  if (!specifier.startsWith(TO_SCOPE)) return specifier
  return `${FROM_SCOPE}${specifier.slice(TO_SCOPE.length)}`
}

const CLIENT_MODULES_NAME = 'dsh-client-modules'
const CLIENT_RUNTIME_NAME = 'dsh-client-runtime'
const WIRE_IDENTITY_FROM = [
  `${TO_SCOPE}${CLIENT_MODULES_NAME}`,
  `${TO_SCOPE}${CLIENT_RUNTIME_NAME}`,
] as const

/**
 * Restore official `@deepseek-ai/*` plugin identities inside packed CLI
 * `node_modules` so HTML parser-preloads match third-party `inject` lists.
 *
 * Live failure: the inlined `__ModuleLoader__.create()` looks up
 * `CLIENT_MODULES_ID` while host Loader YAML (after rescope) still names
 * `@prettier-ai/*`. Restoring YAML names breaks typert (manifest.package must
 * equal package.json `name`). Keep Loader names published-scope and rewrite
 * the client-modules graph row id onto `@deepseek-ai/*`.
 * @param packageDir - unpacked CLI package directory.
 * @returns Relative paths that changed.
 */
export function restoreOfficialPluginIdentities(packageDir: string): readonly string[] {
  const nodeModules = join(packageDir, 'node_modules')
  if (!existsSync(nodeModules)) return []
  const changed: string[] = []
  for (const packageRoot of collectScopedPackageDirs(nodeModules)) {
    const rel = relative(packageDir, packageRoot).replaceAll('\\', '/')
    const manifestPath = join(packageRoot, 'package.json')
    const manifest = readManifest(manifestPath)
    let manifestChanged = false
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    if (isOfficialAliasDir(packageRoot) && name.startsWith(TO_SCOPE)) {
      manifest.name = officialPluginIdentity(name)
      manifestChanged = true
    }
    if (restoreDshClientIdentities(manifest)) manifestChanged = true
    if (manifestChanged) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      changed.push(`${rel}/package.json`)
    }
    const clientJs = join(packageRoot, 'lib/client.js')
    if (restorePublishedScopeInFile(clientJs)) changed.push(`${rel}/lib/client.js`)
    if (rewriteClientModuleSeedAliases(clientJs) && !changed.includes(`${rel}/lib/client.js`)) {
      changed.push(`${rel}/lib/client.js`)
    }
    if (rewriteClientModuleRequireAliases(clientJs) && !changed.includes(`${rel}/lib/client.js`)) {
      changed.push(`${rel}/lib/client.js`)
    }
    if (isWireIdentityPackage(name, packageRoot)) {
      const libDir = join(packageRoot, 'lib')
      if (existsSync(libDir)) {
        for (const file of readdirSync(libDir)) {
          if (!file.endsWith('.js') || file === 'client.js') continue
          const libFile = join(libDir, file)
          let fileChanged = restoreWireIdsInFile(libFile)
          if (file === 'index.js' && rewriteClientModuleGraphIds(libFile)) fileChanged = true
          if (fileChanged) changed.push(`${rel}/lib/${file}`)
        }
      }
    }
    const assetsDir = join(packageRoot, 'dist/assets')
    if (existsSync(assetsDir)) {
      for (const file of readdirSync(assetsDir)) {
        if (!file.endsWith('.js')) continue
        if (restorePublishedScopeInFile(join(assetsDir, file))) {
          changed.push(`${rel}/dist/assets/${file}`)
        }
      }
    }
  }
  return changed
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
  const restored = restoreOfficialPluginIdentities(packageDir)
  let changed = restored.length > 0
  let manifestChanged = false
  for (const section of INSTALL_SECTIONS) {
    const current = stringRecord(manifest[section])
    if (Object.keys(current).length === 0 && manifest[section] === undefined) continue
    const merged = mergeDeepseekAiAliases(Object.keys(current).length === 0 ? undefined : current)
    if (!merged.changed) continue
    manifest[section] = merged.deps
    manifestChanged = true
    changed = true
  }
  // Restore rewrites node_modules only. Do not re-serialize the CLI manifest
  // unless aliases actually changed (bundled CLI has empty graph deps).
  if (manifestChanged) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

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
    if (!body.includes('function isHostSpecifier')) {
      failures.push(
        `${filename}: ${relPath} must resolve host @prettier-ai/* specifiers from the CLI parent`,
      )
    }
    if (!body.includes('function resolveOfficialHost')) {
      failures.push(
        `${filename}: ${relPath} must resolve official @deepseek-ai/* specifiers from CLI aliases before remapping`,
      )
    }
    if (!body.includes('originalParentURL')) {
      failures.push(
        `${filename}: ${relPath} must snapshot context.parentURL before a profile nextResolve`,
      )
    }
    if (!body.includes('function healHostPackageFallback')) {
      failures.push(
        `${filename}: ${relPath} must symlink host packages into $DSH_HOME/profiles/node_modules`,
      )
    }
    if (!body.includes('function installCjsHostResolve')) {
      failures.push(
        `${filename}: ${relPath} must resolve CJS @deepseek-ai/* host specifiers from the CLI for local plugins`,
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
  failures.push(...checkRestoredPluginIdentities(tarball, filename))
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
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
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

function ensureManagedSymlink(link, target) {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error('dsh: ' + link + ' exists and is not a symlink; remove it so dsh can manage the installation fallback')
    }
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    if (error.code !== 'EEXIST' || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error
  }
}

function healHostPackageFallback(cliRoot) {
  const modulesDir = join(resolveDshHome(), 'profiles', 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  for (const scope of [TO.slice(0, -1), FROM.slice(0, -1)]) {
    const scopeDir = join(cliRoot, 'node_modules', scope)
    if (!existsSync(scopeDir)) continue
    let entries
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const target = join(scopeDir, entry.name)
      if (!existsSync(join(target, 'package.json'))) continue
      ensureManagedSymlink(join(modulesDir, scope, entry.name), target)
    }
  }
}

function installCjsHostResolve(cliRoot) {
  const Module = createRequire(import.meta.url)('module')
  const original = Module._resolveFilename
  const cliFilename = join(cliRoot, 'package.json')
  const cliParent = {
    id: cliFilename,
    filename: cliFilename,
    paths: Module._nodeModulePaths(cliRoot),
  }
  Module._resolveFilename = function (request, parent, isMain, options) {
    const importer = parent === undefined || parent === null ? undefined : parent.filename
    const fromOutside = typeof importer !== 'string' || importer === '' || !pathIsInside(cliRoot, importer)
    if (fromOutside && typeof request === 'string' && (isOfficialHostSpecifier(request) || isHostSpecifier(request))) {
      try {
        return original.call(this, request, cliParent, isMain, options)
      } catch {
        const mapped = mapSpecifier(request)
        if (mapped !== undefined) {
          try {
            return original.call(this, mapped, cliParent, isMain, options)
          } catch {
            // fall through to the real importer
          }
        }
      }
    }
    return original.call(this, request, parent, isMain, options)
  }
}

function isBarePackageSpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('node:')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false
  return true
}

function isHostSpecifier(specifier) {
  return typeof specifier === 'string' && (specifier === TO.slice(0, -1) || specifier.startsWith(TO))
}

function isOfficialHostSpecifier(specifier) {
  return typeof specifier === 'string' && (specifier === FROM.slice(0, -1) || specifier.startsWith(FROM))
}

function shouldResolveFromProfile(specifier, parentURL) {
  if (!isBarePackageSpecifier(specifier)) return false
  if (isHostSpecifier(specifier) || isOfficialHostSpecifier(specifier)) return false
  if (parentIsUnderProfiles(parentURL)) return false
  return true
}

function resolveOfficialHost(specifier, context, nextResolve, cliParentURL) {
  const originalParentURL = context.parentURL
  const mapped = mapSpecifier(specifier)
  const fromCli = (id) => nextResolve(id, { ...context, parentURL: cliParentURL })
  // Must stay synchronous: Node 24 registerHooks runs from resolveSync.
  // Returning a Promise makes url undefined (ERR_INVALID_RETURN_PROPERTY_VALUE).
  if (mapped !== undefined) {
    try {
      return fromCli(specifier)
    } catch {
      try {
        return fromCli(mapped)
      } catch {
        return nextResolve(specifier, { ...context, parentURL: originalParentURL })
      }
    }
  }
  if (isHostSpecifier(specifier)) {
    try {
      return fromCli(specifier)
    } catch {
      return nextResolve(specifier, { ...context, parentURL: originalParentURL })
    }
  }
  return undefined
}

function resolveMapped(specifier, context, nextResolve, cliParentURL) {
  const originalParentURL = context.parentURL
  const host = resolveOfficialHost(specifier, context, nextResolve, cliParentURL)
  if (host !== undefined) return host
  // Official: profile node_modules first, then the rest. Do not remap
  // dshmarket, @dsh-ssh/*, @aaravarr/*, or dsh-subagent-sidebar.
  // Snapshot parentURL: Node 22 module.register mutates context.parentURL
  // after a failed nextResolve with a different parent.
  if (shouldResolveFromProfile(specifier, originalParentURL)) {
    for (const parentURL of profileParentURLs()) {
      try {
        return nextResolve(specifier, { ...context, parentURL })
      } catch {
        // try the next profile directory
      }
    }
  }
  return nextResolve(specifier, { ...context, parentURL: originalParentURL })
}

async function registerCompat() {
  const cliRoot = findInstallRoot(import.meta.url)
  healHostPackageFallback(cliRoot)
  installCjsHostResolve(cliRoot)
  const cliParentURL = pathToFileURL(join(cliRoot, 'package.json')).href
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

function isHostSpecifier(specifier) {
  return typeof specifier === 'string' && (specifier === TO.slice(0, -1) || specifier.startsWith(TO))
}

function isOfficialHostSpecifier(specifier) {
  return typeof specifier === 'string' && (specifier === FROM.slice(0, -1) || specifier.startsWith(FROM))
}

function shouldResolveFromProfile(specifier, parentURL) {
  if (!isBarePackageSpecifier(specifier)) return false
  if (isHostSpecifier(specifier) || isOfficialHostSpecifier(specifier)) return false
  if (parentIsUnderProfiles(parentURL)) return false
  return true
}

async function resolveOfficialHost(specifier, context, nextResolve) {
  const originalParentURL = context.parentURL
  const mapped = typeof specifier === 'string' && specifier.startsWith(FROM)
    ? TO + specifier.slice(FROM.length)
    : undefined
  const parent = cliParentURL || originalParentURL
  const fromCli = (id) => nextResolve(id, { ...context, parentURL: parent })
  if (mapped !== undefined) {
    try {
      return await fromCli(specifier)
    } catch {
      try {
        return await fromCli(mapped)
      } catch {
        return nextResolve(specifier, { ...context, parentURL: originalParentURL })
      }
    }
  }
  if (isHostSpecifier(specifier)) {
    try {
      return await fromCli(specifier)
    } catch {
      return nextResolve(specifier, { ...context, parentURL: originalParentURL })
    }
  }
  return undefined
}

export async function resolve(specifier, context, nextResolve) {
  const originalParentURL = context.parentURL
  const host = await resolveOfficialHost(specifier, context, nextResolve)
  if (host !== undefined) return host
  if (shouldResolveFromProfile(specifier, originalParentURL)) {
    for (const parentURL of profileParentURLs()) {
      try {
        return await nextResolve(specifier, { ...context, parentURL })
      } catch {
        // try the next profile directory
      }
    }
  }
  return nextResolve(specifier, { ...context, parentURL: originalParentURL })
}
`
}

function binRelPaths(manifest: PackedManifest): string[] {
  const bin = manifest.bin
  if (typeof bin === 'string' && bin !== '') return [bin]
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return []
  return Object.values(bin).filter((value): value is string => typeof value === 'string' && value !== '')
}

function isOfficialAliasDir(packageRoot: string): boolean {
  return basename(dirname(packageRoot)) === '@deepseek-ai'
}

function isWireIdentityPackage(name: string, packageRoot: string): boolean {
  const base = basename(packageRoot)
  return name.endsWith(`/${CLIENT_MODULES_NAME}`)
    || name.endsWith(`/${CLIENT_RUNTIME_NAME}`)
    || base === CLIENT_MODULES_NAME
    || base === CLIENT_RUNTIME_NAME
}

function packedMemberText(tarball: string, member: string): string | undefined {
  const result = spawnSync('tar', ['-xOzf', tarball, member], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) return undefined
  return result.stdout ?? ''
}

function packedManifestName(body: string): string {
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  if (!('name' in parsed)) return ''
  const name = parsed.name
  return typeof name === 'string' ? name : ''
}

function checkRestoredPluginIdentities(tarball: string, filename: string): string[] {
  const failures: string[] = []
  const modulesIndex = 'package/node_modules/@prettier-ai/dsh-client-modules/lib/index.js'
  if (tarballHasMember(tarball, modulesIndex)) {
    const body = packedMemberText(tarball, modulesIndex)
    if (body === undefined) {
      failures.push(`${filename}: failed to read ${modulesIndex}`)
    } else {
      for (const published of WIRE_IDENTITY_FROM) {
        if (body.includes(published)) {
          failures.push(`${filename}: ${modulesIndex} still contains ${published}`)
        }
      }
      if (!body.includes(`${FROM_SCOPE}${CLIENT_MODULES_NAME}`)) {
        failures.push(`${filename}: ${modulesIndex} is missing ${FROM_SCOPE}${CLIENT_MODULES_NAME}`)
      }
      if (body.includes(CLIENT_MODULE_PROCESS_ONE) && !body.includes('graphRow(wireId, rev, meta)')) {
        failures.push(
          `${filename}: ${modulesIndex} must emit official @deepseek-ai graph ids from published-scope Loader names`,
        )
      }
      if (body.includes(CLIENT_MODULE_RECONCILE_PACKAGE) && !body.includes('graphRow(wireId, rev, source.meta)')) {
        failures.push(
          `${filename}: ${modulesIndex} must emit official @deepseek-ai graph ids from 0.1.2 reconcilePackage`,
        )
      }
    }
  }
  const modulesClient = 'package/node_modules/@prettier-ai/dsh-client-modules/lib/client.js'
  if (tarballHasMember(tarball, modulesClient)) {
    const body = packedMemberText(tarball, modulesClient)
    if (body === undefined) {
      failures.push(`${filename}: failed to read ${modulesClient}`)
    } else {
      if (body.includes(`${TO_SCOPE}${CLIENT_MODULES_NAME}`)) {
        failures.push(`${filename}: ${modulesClient} still registers ${TO_SCOPE}${CLIENT_MODULES_NAME}`)
      }
      if (body.includes('this.seed = new Map(Object.entries(options.staticModules))') && !body.includes('this.seed.set(alt, val)')) {
        failures.push(
          `${filename}: ${modulesClient} must alias platform seed keys across @prettier-ai and @deepseek-ai`,
        )
      }
      if (body.includes('makeRequire(edges)') && !body.includes('altSpec')) {
        failures.push(
          `${filename}: ${modulesClient} must look up the other scope in makeRequire/import`,
        )
      }
    }
  }
  const aliasManifestPath = 'package/node_modules/@deepseek-ai/dsh-client-modules/package.json'
  if (tarballHasMember(tarball, aliasManifestPath)) {
    const body = packedMemberText(tarball, aliasManifestPath)
    if (body === undefined) {
      failures.push(`${filename}: failed to read ${aliasManifestPath}`)
    } else {
      const name = packedManifestName(body)
      const expected = `${FROM_SCOPE}${CLIENT_MODULES_NAME}`
      if (name !== expected) {
        failures.push(
          `${filename}: ${aliasManifestPath} name is ${JSON.stringify(name)}, expected ${JSON.stringify(expected)}`,
        )
      }
    }
  }
  return failures
}

function restoreDshClientIdentities(manifest: PackedManifest): boolean {
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return false
  const client = (dsh as Record<string, unknown>).client
  if (client === null || typeof client !== 'object' || Array.isArray(client)) return false
  const record = client as Record<string, unknown>
  let changed = false
  for (const field of ['inject', 'external'] as const) {
    const value = record[field]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) continue
    const next = value.map(item => officialPluginIdentity(item))
    if (next.some((item, index) => item !== value[index])) {
      record[field] = next
      changed = true
    }
  }
  return changed
}

function restorePublishedScopeInFile(path: string): boolean {
  if (!existsSync(path)) return false
  const before = readFileSync(path, 'utf8')
  if (!before.includes(TO_SCOPE)) return false
  writeFileSync(path, before.replaceAll(TO_SCOPE, FROM_SCOPE))
  return true
}

function restoreWireIdsInFile(path: string): boolean {
  if (!existsSync(path)) return false
  let body = readFileSync(path, 'utf8')
  let changed = false
  for (const published of WIRE_IDENTITY_FROM) {
    const official = officialPluginIdentity(published)
    if (!body.includes(published)) continue
    body = body.replaceAll(published, official)
    changed = true
  }
  if (changed) writeFileSync(path, body)
  return changed
}

/** Official compiled `ClientModuleRegistry.processOne` (tabs, 0.1.1-rc.2). */
const CLIENT_MODULE_PROCESS_ONE = `\tprocessOne(entryName) {
\t\tlet qualifies = false;
\t\tfor (const entry of this.ctx.loader.entries()) if (entry.options.name === entryName && entry.fiber !== void 0 && !entry.disabled) {
\t\t\tqualifies = true;
\t\t\tbreak;
\t\t}
\t\tif (!qualifies) return this.table.delete(entryName);
\t\tif (this.table.has(entryName)) return false;
\t\tconst meta = this.resolveMeta(entryName);
\t\tif (meta === null) return false;
\t\tconst rev = this.initialBundleRevision(entryName, meta.clientPath);
\t\tthis.table.set(entryName, {
\t\t\tentry: graphRow(entryName, rev, meta),
\t\t\tmeta
\t\t});
\t\treturn true;
\t}`

/** Graph ids must be `@deepseek-ai/*` so HTML preloads and third-party inject match. */
const CLIENT_MODULE_PROCESS_ONE_WIRE = `\tprocessOne(entryName) {
\t\tconst wireId = entryName.startsWith("@prettier-ai/") ? "@deepseek-ai/" + entryName.slice("@prettier-ai/".length) : entryName;
\t\tlet qualifies = false;
\t\tfor (const entry of this.ctx.loader.entries()) if (entry.options.name === entryName && entry.fiber !== void 0 && !entry.disabled) {
\t\t\tqualifies = true;
\t\t\tbreak;
\t\t}
\t\tif (!qualifies) return this.table.delete(wireId);
\t\tif (this.table.has(wireId)) return false;
\t\tconst meta = this.resolveMeta(entryName) ?? this.resolveMeta(wireId);
\t\tif (meta === null) return false;
\t\tconst rev = this.initialBundleRevision(entryName, meta.clientPath);
\t\tthis.table.set(wireId, {
\t\t\tentry: graphRow(wireId, rev, meta),
\t\t\tmeta
\t\t});
\t\treturn true;
\t}`

/** Official compiled 0.1.2-alpha.1 `reconcilePackage` (tabs). */
const CLIENT_MODULE_RECONCILE_PACKAGE = [
	'\treconcilePackage(packageName) {',
	'\t\tconst sources = [];',
	'\t\tfor (const source of this.sources.values()) if (source.packageName === packageName) sources.push(source);',
	'\t\tif (sources.length > 1) {',
	'\t\t\tconst locations = sources.map((source) => `${JSON.stringify(source.loaderName)} from ${source.baseUrl}`).join(", ");',
	'\t\t\tthrow new Error(`client-modules: package ${packageName} resolves from multiple active Loader sources: ${locations}; remove one entry`);',
	'\t\t}',
	'\t\tconst source = sources[0];',
	'\t\tif (source === void 0) return this.table.delete(packageName);',
	'\t\tif (this.table.get(packageName)?.sourceKey === source.sourceKey) return false;',
	'\t\tconst snapshot = this.initialBundleSnapshot(packageName, source.meta.clientPath);',
	'\t\tconst rev = this.allocateInitialRevision();',
	'\t\tthis.table.set(packageName, {',
	'\t\t\tentry: graphRow(packageName, rev, source.meta),',
	'\t\t\tloaderName: source.loaderName,',
	'\t\t\tsourceKey: source.sourceKey,',
	'\t\t\tmeta: source.meta,',
	'\t\t\tbundle: snapshot.bundle,',
	'\t\t\tbaseline: snapshot.baseline,',
	'\t\t\t...snapshot.sourceMap === void 0 ? {} : { sourceMap: snapshot.sourceMap }',
	'\t\t});',
	'\t\treturn true;',
	'\t}',
].join('\n')

/** Graph ids must be `@deepseek-ai/*`; disk snapshot still uses the published-scope package name. */
const CLIENT_MODULE_RECONCILE_PACKAGE_WIRE = [
	'\treconcilePackage(packageName) {',
	'\t\tconst wireId = packageName.startsWith("@prettier-ai/") ? "@deepseek-ai/" + packageName.slice("@prettier-ai/".length) : packageName;',
	'\t\tconst sources = [];',
	'\t\tfor (const source of this.sources.values()) if (source.packageName === packageName) sources.push(source);',
	'\t\tif (sources.length > 1) {',
	'\t\t\tconst locations = sources.map((source) => `${JSON.stringify(source.loaderName)} from ${source.baseUrl}`).join(", ");',
	'\t\t\tthrow new Error(`client-modules: package ${packageName} resolves from multiple active Loader sources: ${locations}; remove one entry`);',
	'\t\t}',
	'\t\tconst source = sources[0];',
	'\t\tif (source === void 0) return this.table.delete(wireId);',
	'\t\tif (this.table.get(wireId)?.sourceKey === source.sourceKey) return false;',
	'\t\tconst snapshot = this.initialBundleSnapshot(packageName, source.meta.clientPath);',
	'\t\tconst rev = this.allocateInitialRevision();',
	'\t\tthis.table.set(wireId, {',
	'\t\t\tentry: graphRow(wireId, rev, source.meta),',
	'\t\t\tloaderName: source.loaderName,',
	'\t\t\tsourceKey: source.sourceKey,',
	'\t\t\tmeta: source.meta,',
	'\t\t\tbundle: snapshot.bundle,',
	'\t\t\tbaseline: snapshot.baseline,',
	'\t\t\t...snapshot.sourceMap === void 0 ? {} : { sourceMap: snapshot.sourceMap }',
	'\t\t});',
	'\t\treturn true;',
	'\t}',
].join('\n')

/** Official compiled `makeRequire` + `import` (tabs, 0.1.1-rc.2 and 0.1.2-alpha.1). */
const CLIENT_MODULE_MAKE_REQUIRE = [
	'\t\t\tmakeRequire(edges) {',
	'\t\t\t\treturn (spec) => {',
	'\t\t\t\t\tedges.add(spec);',
	'\t\t\t\t\tif (this.seed.has(spec)) return this.seed.get(spec);',
	'\t\t\t\t\tconst id = stripClientSuffix(spec);',
	'\t\t\t\t\tconst record = this.loadCache.get(id);',
	'\t\t\t\t\tif (record !== void 0) return record.exports;',
	'\t\t\t\t\tif (this.factories.has(id)) return this.materialize(id).exports;',
	'\t\t\t\t\tthrow new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);',
	'\t\t\t\t};',
	'\t\t\t}',
	'\t\t\tasync import(specifier) {',
	'\t\t\t\tif (this.seed.has(specifier)) return this.seed.get(specifier);',
	'\t\t\t\tconst id = stripClientSuffix(specifier);',
	'\t\t\t\tconst existing = this.loadCache.get(id);',
	'\t\t\t\tif (existing !== void 0) return existing.exports;',
	'\t\t\t\tconst row = this.graphRows.get(id);',
	'\t\t\t\tif (row !== void 0) await this.arriveGraphRow(row);',
	'\t\t\t\telse if (!this.factories.has(id)) throw new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`);',
	'\t\t\t\treturn this.materialize(id).exports;',
	'\t\t\t}',
].join('\n')

/** Retry the other scope so a third-party @deepseek-ai require hits a @prettier-ai seed/factory. */
const CLIENT_MODULE_MAKE_REQUIRE_ALIASED = [
	'\t\t\tmakeRequire(edges) {',
	'\t\t\t\treturn (spec) => {',
	'\t\t\t\t\tedges.add(spec);',
	'\t\t\t\t\tconst published = "@prettier" + "-ai/";',
	'\t\t\t\t\tconst official = "@deepseek" + "-ai/";',
	'\t\t\t\t\tconst altSpec = spec.startsWith(published) ? official + spec.slice(published.length) : spec.startsWith(official) ? published + spec.slice(official.length) : spec;',
	'\t\t\t\t\tif (this.seed.has(spec)) return this.seed.get(spec);',
	'\t\t\t\t\tif (altSpec !== spec && this.seed.has(altSpec)) return this.seed.get(altSpec);',
	'\t\t\t\t\tconst id = stripClientSuffix(spec);',
	'\t\t\t\t\tconst altId = stripClientSuffix(altSpec);',
	'\t\t\t\t\tconst record = this.loadCache.get(id) ?? (altId !== id ? this.loadCache.get(altId) : void 0);',
	'\t\t\t\t\tif (record !== void 0) return record.exports;',
	'\t\t\t\t\tif (this.factories.has(id)) return this.materialize(id).exports;',
	'\t\t\t\t\tif (altId !== id && this.factories.has(altId)) return this.materialize(altId).exports;',
	'\t\t\t\t\tthrow new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);',
	'\t\t\t\t};',
	'\t\t\t}',
	'\t\t\tasync import(specifier) {',
	'\t\t\t\tconst published = "@prettier" + "-ai/";',
	'\t\t\t\tconst official = "@deepseek" + "-ai/";',
	'\t\t\t\tconst altSpec = specifier.startsWith(published) ? official + specifier.slice(published.length) : specifier.startsWith(official) ? published + specifier.slice(official.length) : specifier;',
	'\t\t\t\tif (this.seed.has(specifier)) return this.seed.get(specifier);',
	'\t\t\t\tif (altSpec !== specifier && this.seed.has(altSpec)) return this.seed.get(altSpec);',
	'\t\t\t\tconst id = stripClientSuffix(specifier);',
	'\t\t\t\tconst altId = stripClientSuffix(altSpec);',
	'\t\t\t\tconst existing = this.loadCache.get(id) ?? (altId !== id ? this.loadCache.get(altId) : void 0);',
	'\t\t\t\tif (existing !== void 0) return existing.exports;',
	'\t\t\t\tconst row = this.graphRows.get(id) ?? (altId !== id ? this.graphRows.get(altId) : void 0);',
	'\t\t\t\tif (row !== void 0) await this.arriveGraphRow(row);',
	'\t\t\t\telse if (!this.factories.has(id) && (altId === id || !this.factories.has(altId))) throw new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`);',
	'\t\t\t\treturn this.materialize(this.factories.has(id) || this.graphRows.has(id) ? id : altId).exports;',
	'\t\t\t}',
].join('\n')

/** Official compiled ClientModuleSystem constructor seed assignment (0.1.1-rc.2). */
const CLIENT_MODULE_SEED_INIT = `\t\t\tconstructor(options) {
\t\t\t\tthis.manifest = options.manifest;
\t\t\t\tthis.seed = new Map(Object.entries(options.staticModules));
\t\t\t\tthis.loadBundle = options.loadBundle ?? defaultLoadBundle;`

/** Duplicate each platform seed under the other scope so third-party @deepseek-ai requires hit a @prettier-ai Vite table and the reverse.
 * Scope strings are split so a later restorePublishedScopeInFile replaceAll cannot collapse both branches. */
const CLIENT_MODULE_SEED_ALIASED = `\t\t\tconstructor(options) {
\t\t\t\tthis.manifest = options.manifest;
\t\t\t\tthis.seed = new Map(Object.entries(options.staticModules));
\t\t\t\tfor (const [key, val] of [...this.seed]) {
\t\t\t\t\tconst published = "@prettier" + "-ai/";
\t\t\t\t\tconst official = "@deepseek" + "-ai/";
\t\t\t\t\tif (key.startsWith(published)) {
\t\t\t\t\t\tconst alt = official + key.slice(published.length);
\t\t\t\t\t\tif (!this.seed.has(alt)) this.seed.set(alt, val);
\t\t\t\t\t} else if (key.startsWith(official)) {
\t\t\t\t\t\tconst alt = published + key.slice(official.length);
\t\t\t\t\t\tif (!this.seed.has(alt)) this.seed.set(alt, val);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tthis.loadBundle = options.loadBundle ?? defaultLoadBundle;`

/**
 * Copy platform seed entries onto both published and official scopes.
 * Vite `Jd()` may still be `@prettier-ai/*` when a pack skipped asset restore;
 * third-party factories always `require("@deepseek-ai/dsh-client-ui-primitives")`.
 * @param path - packed `dsh-client-modules/lib/client.js`.
 */
function rewriteClientModuleSeedAliases(path: string): boolean {
  if (!existsSync(path)) return false
  const before = readFileSync(path, 'utf8')
  if (before.includes('this.seed.set(alt, val)')) return false
  if (!before.includes(CLIENT_MODULE_SEED_INIT)) return false
  writeFileSync(path, before.replace(CLIENT_MODULE_SEED_INIT, CLIENT_MODULE_SEED_ALIASED))
  return true
}

/**
 * Look up seed/factory/graph rows under the other scope.
 * Constructor seed copies are not enough when factories are keyed by one
 * identity and a third-party plugin requires the other.
 * @param path - packed `dsh-client-modules/lib/client.js`.
 */
function rewriteClientModuleRequireAliases(path: string): boolean {
  if (!existsSync(path)) return false
  const before = readFileSync(path, 'utf8')
  if (before.includes('altSpec')) return false
  if (!before.includes(CLIENT_MODULE_MAKE_REQUIRE)) return false
  writeFileSync(path, before.replace(CLIENT_MODULE_MAKE_REQUIRE, CLIENT_MODULE_MAKE_REQUIRE_ALIASED))
  return true
}

/**
 * Key the web plugin table by official wire ids. Loader YAML stays
 * `@prettier-ai/*` (typert / package.json `name`); `createRequire(profile)`
 * still resolves the published-scope package.
 * @param path - packed `dsh-client-modules/lib/index.js`.
 */
function rewriteClientModuleGraphIds(path: string): boolean {
  if (!existsSync(path)) return false
  const before = readFileSync(path, 'utf8')
  let body = before
  if (body.includes(CLIENT_MODULE_PROCESS_ONE)) {
    body = body.replace(CLIENT_MODULE_PROCESS_ONE, CLIENT_MODULE_PROCESS_ONE_WIRE)
  }
  if (body.includes(CLIENT_MODULE_RECONCILE_PACKAGE)) {
    body = body.replace(CLIENT_MODULE_RECONCILE_PACKAGE, CLIENT_MODULE_RECONCILE_PACKAGE_WIRE)
  }
  if (body === before) return false
  writeFileSync(path, body)
  return true
}

function collectScopedPackageDirs(nodeModulesDir: string): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const visitNodeModules = (nm: string): void => {
    for (const scope of ['@prettier-ai', '@deepseek-ai']) {
      const scopeDir = join(nm, scope)
      if (!existsSync(scopeDir)) continue
      let entries
      try {
        entries = readdirSync(scopeDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(scopeDir, entry.name)
        if (seen.has(full)) continue
        seen.add(full)
        if (!existsSync(join(full, 'package.json'))) continue
        dirs.push(full)
        const nested = join(full, 'node_modules')
        if (existsSync(nested)) visitNodeModules(nested)
      }
    }
  }
  visitNodeModules(nodeModulesDir)
  return dirs
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
