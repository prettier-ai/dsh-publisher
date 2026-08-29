/**
 * Bundle `@prettier-ai/dsh` from an already-resolved workspace so npm does
 * not walk the workspace peer graph at install time.
 *
 * `pnpm --dir apps/cli pack` (and `release:pack --family dsh` for the CLI
 * member) emit a thin tarball whose `dependencies` list ~70 `@prettier-ai/*`
 * workspace packages. Each of those carries many peerDependencies; npm
 * arborist then CPU-spins until OOM. This script `pnpm deploy`s the CLI from
 * the lockfile, copies production `node_modules` into the tarball, and strips
 * those workspace names from the published manifest.
 *
 * `pnpm deploy` hard-links files from the content-addressable store and leaves
 * hoisted `@prettier-ai/*` names as symlinks into `.pnpm`. GNU tar would store
 * those as hard-link / symlink members, and npm then rejects the PUT with
 * `E415`. Copy the deploy tree with `dereference: true` into a snapshot first
 * so the archive has only regular files. Node's `cpSync({ dereference: true })`
 * still leaves file-type symlinks (pnpm `.bin` shims). Walk those after the copy
 * and replace them with real files. Do not `tar --dereference` a live tree that
 * still contains `.pnpm` + hoisted directory symlinks: GNU tar then reports
 * `File removed before we read it` (0.1.2-alpha.1 Pack CLI, schemastery).
 *
 * `pnpm deploy --prod --legacy` may still omit nested workspace packages that
 * only appear as `workspace:^` (or `link:`) edges of vendor packages already
 * in the deploy tree (cosmokit is the first crash). After deploy, this script
 * walks deploy `node_modules` and copies missing workspace members in as real
 * directories until the graph closes. It does not put those names back on the
 * published CLI `dependencies`.
 *
 * Official `npm i -g @deepseek-ai/dsh` is a thin package: npm fetches `sharp` /
 * `koffi` platform optional packages for the installing OS. This fat tarball is
 * built on ubuntu-24.04, so a default install would keep only Linux natives and
 * Windows `dshp web` would fail to load `sharp` and Koffi. Before install/deploy,
 * write pnpm `supportedArchitectures` (linux/win32/darwin, x64/arm64, glibc/musl)
 * so those optional payloads are fetched. After deploy, copy them into the
 * deploy tree as real directories (no symlinks, no hardlinks). They live in
 * bundled `node_modules` and are not listed on the published CLI manifest.
 *
 * The packed bin stays `dsh` at `lib/bin.js`. This script does not add `dshp`.
 * Host-side `@deepseek-ai/*` compatibility is applied to the deploy directory
 * (runtime loader) before packing. Install-time npm aliases are not written:
 * they would put `@prettier-ai/*` back on `dependencies`. The wrapper heals
 * `$DSH_HOME/profiles/node_modules` with those bundled directories so CJS
 * `createRequire(profile)` can see host plugins. Alias copies stamp
 * `package.json` `name` back to `@deepseek-ai/<name>`; published-scope copies
 * keep `@prettier-ai/<name>`. Official 0.1.2 dropped
 * `@deepseek-ai/dsh-client-runtime`. Production pack vendors
 * `@deepseek-ai/dsh-client-runtime@0.1.1-rc.2` under
 * `node_modules/@prettier-ai/dsh-client-runtime` (not listed on CLI
 * `dependencies`) so 0.1.1 plugins can still require that factory. Unit tests
 * leave `vendorLegacyClientRuntime` off unless they pass a local tarball.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bundle-cli.ts --workspace <dir> --out dist/npm-cli
 *   node --experimental-strip-types scripts/bundle-cli.ts --workspace <dir> --out dist/npm --replace
 *   node --experimental-strip-types scripts/bundle-cli.ts --published-version --official <ver> [--suffix <id>] [--npm-version <ver>]
 *   node --experimental-strip-types scripts/bundle-cli.ts --apply-supported-architectures --workspace <dir>
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { injectPackageDir } from './inject-deepseek-ai-compat.ts'

export const CLI_PACKAGE_NAME = '@prettier-ai/dsh'
export const CLI_BIN_NAME = 'dsh'
export const CLI_BIN_PATH = 'lib/bin.js'
export const CLI_PNPM_FILTER = './apps/cli'

/** Nested workspace packages that must land in the packed tarball when present. */
export const PACKED_NESTED_WORKSPACE_PACKAGES = [
  '@prettier-ai/cosmokit',
  '@prettier-ai/schemastery',
] as const

/** pnpm setting so optional natives are fetched for every OS we publish, not just the pack runner. */
export const PNPM_SUPPORTED_ARCHITECTURES = {
  os: ['linux', 'win32', 'darwin'],
  cpu: ['x64', 'arm64'],
  libc: ['glibc', 'musl'],
} as const

const GRAPH_SCOPES = ['@prettier-ai/', '@deepseek-ai/'] as const
const INSTALL_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
const NPM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SUFFIX_ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/

interface PackedIdentity {
  readonly name: string
  readonly version: string
  readonly file: string
}

/** Optional pack knobs. `workspace` closes nested workspace deps; `version` stamps only the CLI manifest. */
export interface PackBundledOptions {
  readonly workspace?: string | undefined
  readonly version?: string | undefined
  /** Extra `node_modules` to copy native optional packages from (unit-test stub). */
  readonly nativeModules?: string | undefined
  /**
   * Vendor `@deepseek-ai/dsh-client-runtime@0.1.1-rc.2` when the deploy tree
   * has no client factory. Production pack sets this; unit tests leave it off
   * so they do not hit the network.
   */
  readonly vendorLegacyClientRuntime?: boolean | undefined
  /** Local tarball for tests. Production pack omits this and runs `npm pack`. */
  readonly legacyClientRuntimeTarball?: string | undefined
}

/** Last official client-runtime that third-party 0.1.1 plugins still require. */
export const LEGACY_CLIENT_RUNTIME_SPEC = '@deepseek-ai/dsh-client-runtime@0.1.1-rc.2'

/**
 * Workspace / official-scope names that make npm resolve the peer graph.
 * @param name - dependency name.
 * @param range - dependency range (workspace: protocol is also a graph edge).
 */
export function isPublishedGraphDependency(name: string, range: string): boolean {
  if (GRAPH_SCOPES.some(scope => name.startsWith(scope))) return true
  return range.startsWith('workspace:')
}

/**
 * Names under `dependencies` that match `@prettier-ai/dsh` or `@prettier-ai/dsh-*`.
 * @param dependencies - one manifest section.
 */
export function prettierAiDshStarDependencyNames(
  dependencies: Readonly<Record<string, string>> | undefined,
): string[] {
  if (dependencies === undefined) return []
  return Object.keys(dependencies).filter(name => name === CLI_PACKAGE_NAME || name.startsWith(`${CLI_PACKAGE_NAME}-`))
}

/**
 * Every `@prettier-ai/*` and `@deepseek-ai/*` name in one section.
 * @param dependencies - one manifest section.
 */
export function scopedWorkspaceDependencyNames(
  dependencies: Readonly<Record<string, string>> | undefined,
): string[] {
  if (dependencies === undefined) return []
  return Object.keys(dependencies).filter(name => GRAPH_SCOPES.some(scope => name.startsWith(scope)))
}

/**
 * Join an official npm version with an operator-supplied Pack CLI suffix.
 * Empty suffix keeps the official version. Non-empty becomes `{official}-{suffix}`.
 * @param officialVersion - version from the official git tag / probe.
 * @param suffix - optional `workflow_dispatch` input; not auto-incremented.
 */
export function publishedNpmVersion(officialVersion: string, suffix: string | undefined): string {
  if (!isNpmVersion(officialVersion)) {
    throw new Error(`bundle-cli: official version ${JSON.stringify(officialVersion)} is not a valid npm version`)
  }
  if (suffix === undefined || suffix === '') return officialVersion
  if (suffix.trim() === '' || suffix.trim() !== suffix || /\s/.test(suffix) || suffix.includes('/')) {
    throw new Error(
      'bundle-cli: suffix must be non-empty after trim and must not contain whitespace or slashes',
    )
  }
  if (!SUFFIX_ID.test(suffix) || suffix.includes('..') || suffix.endsWith('.') || suffix.endsWith('-')) {
    throw new Error(`bundle-cli: suffix ${JSON.stringify(suffix)} is not a valid npm prerelease identifier`)
  }
  const version = `${officialVersion}-${suffix}`
  if (!isNpmVersion(version)) {
    throw new Error(`bundle-cli: ${JSON.stringify(version)} is not a valid npm version`)
  }
  return version
}

/** Options for resolving the published CLI / dshp npm version. */
export interface ResolvePublishedVersionOptions {
  readonly npmVersion?: string | undefined
  readonly suffix?: string | undefined
}

/**
 * Resolve the npm version stamped on the packed CLI and dshp.
 * `npmVersion` is an exact override (e.g. `0.1.1-rc.2-bundle.1` for a burned
 * registry version). It is not a suffix and is not auto-appended to official.
 * When `npmVersion` is empty, `suffix` joins as `{official}-{suffix}`.
 * @param officialVersion - version from the official git tag / probe.
 * @param options - optional `npm_version` and `suffix` workflow inputs.
 */
export function resolvePublishedVersion(
  officialVersion: string,
  options: ResolvePublishedVersionOptions = {},
): string {
  const npmVersion = options.npmVersion
  if (npmVersion !== undefined && npmVersion !== '') {
    if (npmVersion.trim() !== npmVersion || /\s/.test(npmVersion) || npmVersion.includes('/')) {
      throw new Error('bundle-cli: npm_version must not contain whitespace or slashes')
    }
    if (!isNpmVersion(npmVersion)) {
      throw new Error(`bundle-cli: npm_version ${JSON.stringify(npmVersion)} is not a valid npm version`)
    }
    return npmVersion
  }
  return publishedNpmVersion(officialVersion, options.suffix)
}

/**
 * Parse the `packages:` list from a `pnpm-workspace.yaml`.
 * @param text - file contents.
 */
export function parsePnpmWorkspacePackageGlobs(text: string): string[] {
  const globs: string[] = []
  let inPackages = false
  for (const line of text.split(/\r?\n/)) {
    if (!inPackages) {
      if (/^packages:\s*(?:#.*)?$/.test(line)) inPackages = true
      continue
    }
    if (/^[A-Za-z][\w-]*\s*:/.test(line)) break
    const stripped = line.replace(/\s+#.*$/, '')
    if (stripped.trim() === '') continue
    const item = stripped.match(/^\s+-\s+(.+)$/)
    if (item?.[1] === undefined) continue
    const glob = item[1].trim().replace(/^['"]|['"]$/g, '')
    if (glob !== '') globs.push(glob)
  }
  return globs
}

/**
 * Map workspace package names to their directories in a rescoped checkout.
 * @param workspaceRoot - official checkout root (after rescope).
 */
export function workspacePackageLocations(workspaceRoot: string): ReadonlyMap<string, string> {
  const globs = readWorkspacePackageGlobs(workspaceRoot)
  const map = new Map<string, string>()
  for (const glob of globs) {
    if (glob.startsWith('!')) continue
    const pattern = `${glob.replace(/\/$/, '')}/package.json`
    for (const relative of globSync(pattern, { cwd: workspaceRoot })) {
      const abs = resolve(workspaceRoot, relative)
      const name = readJsonObject(abs).name
      if (typeof name !== 'string' || name === '') continue
      map.set(name, dirname(abs))
    }
  }
  return map
}

/**
 * Copy missing workspace packages into the deploy `node_modules` until a pass
 * adds nothing. Nested vendor edges (cosmokit via cordis) are the class of hole;
 * this is not a cosmokit-only special case.
 * @param deployDir - `pnpm deploy` output directory.
 * @param workspaceRoot - rescoped checkout with `pnpm-workspace.yaml`.
 */
export function fillMissingWorkspacePackages(deployDir: string, workspaceRoot: string): readonly string[] {
  const members = workspacePackageLocations(workspaceRoot)
  const added: string[] = []
  for (;;) {
    const missing = missingWorkspaceDeps(deployDir, members)
    if (missing.length === 0) break
    let addedThisPass = 0
    for (const name of missing) {
      const src = members.get(name)
      if (src === undefined) continue
      const dest = join(deployDir, 'node_modules', ...name.split('/'))
      if (existsSync(dest)) continue
      copyWorkspacePackage(src, dest)
      added.push(name)
      addedThisPass += 1
    }
    if (addedThisPass === 0) break
  }
  return added
}

/**
 * Write pnpm `supportedArchitectures` onto a checkout's `pnpm-workspace.yaml`
 * so a later `pnpm install` / `pnpm deploy` fetches win32 and darwin optional
 * natives, not only the runner's linux packages.
 * @param workspaceRoot - official checkout root (after rescope).
 */
export function applyPnpmSupportedArchitectures(workspaceRoot: string): void {
  const yamlPath = join(workspaceRoot, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) {
    throw new Error(`bundle-cli: ${yamlPath} does not exist`)
  }
  const stripped = stripTopLevelYamlKey(readFileSync(yamlPath, 'utf8'), 'supportedArchitectures').replace(/\s+$/, '')
  writeFileSync(yamlPath, `${stripped}\n\n${pnpmSupportedArchitecturesYaml()}\n`)
}

/**
 * Whether a package is a native optional payload official npm would install on
 * some OS (sharp platform packages, koffi prebuilds, landlock addons).
 * `@prettier-ai/*` / `@deepseek-ai/*` workspace names stay off the published
 * CLI manifest; landlock platform addons may still live in bundled `node_modules`.
 * @param name - package name.
 */
export function isNativeOptionalPackageName(name: string): boolean {
  if (name.startsWith('@img/')) return true
  if (name.startsWith('@koromix/')) return true
  if (name === 'koffi' || name.startsWith('koffi-')) return true
  if (name.startsWith('node-addon-require-builtin')) return true
  if (name.includes('landlock-run-')) return true
  return false
}

/**
 * Copy native optional packages from a source `node_modules` (workspace install
 * or a test stub) into the deploy tree as real directories: no leftover
 * symlinks or hardlinks. Does not write those names onto the CLI manifest.
 * @param deployDir - `pnpm deploy` output directory.
 * @param sourceNodeModules - workspace or stub `node_modules`.
 */
export function copyNativeOptionalPackages(deployDir: string, sourceNodeModules: string): readonly string[] {
  if (!existsSync(sourceNodeModules)) return []
  const destRoot = join(deployDir, 'node_modules')
  mkdirSync(destRoot, { recursive: true })
  const copied: string[] = []
  for (const [name, src] of collectNativeOptionalPackageDirs(sourceNodeModules)) {
    const dest = join(destRoot, ...name.split('/'))
    if (resolve(src) === resolve(dest)) {
      rematerializeDirectory(dest)
    } else {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true, dereference: true })
    }
    assertNoLinks(dest)
    copied.push(name)
  }
  return copied
}

/**
 * Rewrite a CLI manifest so npm will not resolve the workspace graph.
 * Keeps `bin.dsh`; never adds `dshp`. Clears install-time dependency sections
 * (production files already live in bundled `node_modules`).
 * @param base - parsed `apps/cli` (or deploy-dir) package.json.
 */
export function bundleCliManifest(base: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (base.name !== CLI_PACKAGE_NAME) {
    throw new Error(`bundle-cli: name is ${JSON.stringify(base.name)}, expected ${JSON.stringify(CLI_PACKAGE_NAME)}`)
  }
  const manifest: Record<string, unknown> = { ...base }
  manifest.bin = bundledBin(manifest.bin)
  for (const section of INSTALL_SECTIONS) {
    delete manifest[section]
  }
  delete manifest.peerDependenciesMeta
  delete manifest.devDependencies
  manifest.files = bundledFilesField(manifest.files)
  manifest.bundleDependencies = true
  return manifest
}

/**
 * Ensure `files` includes `node_modules` so the bundled tree is the pack list.
 * @param files - existing `files` field.
 */
export function bundledFilesField(files: unknown): string[] {
  const list = Array.isArray(files)
    ? files.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (!list.includes('node_modules')) list.push('node_modules')
  return list
}

/**
 * Fail if the published CLI would still pull `@prettier-ai/dsh-*` (or any
 * scoped workspace package) from the registry, or if bins are wrong.
 * @param manifest - packed or rewritten manifest.
 */
export function assertBundledCliManifest(manifest: Readonly<Record<string, unknown>>): void {
  if (manifest.name !== CLI_PACKAGE_NAME) {
    throw new Error(`bundle-cli: name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(CLI_PACKAGE_NAME)}`)
  }
  const bin = manifest.bin
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
    throw new Error(`bundle-cli: ${CLI_PACKAGE_NAME} is missing bin.${CLI_BIN_NAME}`)
  }
  const record = bin as Record<string, unknown>
  if (record[CLI_BIN_NAME] !== CLI_BIN_PATH) {
    throw new Error(
      `bundle-cli: bin.${CLI_BIN_NAME} is ${JSON.stringify(record[CLI_BIN_NAME])}, expected ${JSON.stringify(CLI_BIN_PATH)}`,
    )
  }
  if ('dshp' in record) {
    throw new Error('bundle-cli: @prettier-ai/dsh must not publish a dshp bin')
  }
  for (const section of INSTALL_SECTIONS) {
    const deps = stringRecord(manifest[section])
    const graph = scopedWorkspaceDependencyNames(deps)
    if (graph.length > 0) {
      throw new Error(
        `bundle-cli: ${section} still lists registry graph packages: ${graph.join(', ')}`,
      )
    }
    const dshStar = prettierAiDshStarDependencyNames(deps)
    if (dshStar.length > 0) {
      throw new Error(`bundle-cli: ${section} still lists ${dshStar.join(', ')}`)
    }
  }
}

/**
 * Copy `node_modules/@prettier-ai/<name>` to `node_modules/@deepseek-ai/<name>`
 * as a real directory so profile `resolve.paths` still finds official-scope
 * packages without npm aliases on the published manifest. Leftover relative
 * symlinks are replaced: npm publish rejects symlink members with E415.
 * Alias `package.json` `name` is `@deepseek-ai/<name>` so 0.1.2
 * `nearestPackage` accepts the Loader id; the `@prettier-ai` copy keeps the
 * published name.
 * @param nodeModulesDir - bundled `node_modules`.
 */
export function materializeDeepseekAiAliases(nodeModulesDir: string): readonly string[] {
  const prettierScope = join(nodeModulesDir, '@prettier-ai')
  if (!existsSync(prettierScope)) return []
  const deepseekScope = join(nodeModulesDir, '@deepseek-ai')
  mkdirSync(deepseekScope, { recursive: true })
  const created: string[] = []
  for (const name of readdirSync(prettierScope).sort()) {
    if (name === '.' || name === '..') continue
    const dest = join(deepseekScope, name)
    if (isSymbolicLink(dest)) unlinkSync(dest)
    else if (existsSync(dest)) {
      stampOfficialAliasName(dest, name)
      continue
    }
    cpSync(join(prettierScope, name), dest, { recursive: true, dereference: true })
    stampOfficialAliasName(dest, name)
    created.push(`@deepseek-ai/${name}`)
  }
  return created
}

/**
 * Unpack a `dsh-client-runtime` tarball into the published-scope slot.
 * Does not list the package on the CLI manifest.
 * @param packageDir - unpacked CLI package directory.
 * @param tarball - npm pack of `@deepseek-ai/dsh-client-runtime`.
 */
export function installLegacyClientRuntimeTarball(packageDir: string, tarball: string): void {
  const dest = join(packageDir, 'node_modules/@prettier-ai/dsh-client-runtime')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-legacy-runtime-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', tmp])
    const extracted = join(tmp, 'package')
    if (!existsSync(join(extracted, 'package.json'))) {
      throw new Error(`bundle-cli: ${tarball} has no package/package.json`)
    }
    mkdirSync(join(packageDir, 'node_modules/@prettier-ai'), { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    cpSync(extracted, dest, { recursive: true, dereference: true })
    stampPublishedRuntimeName(dest)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (!existsSync(join(dest, 'lib/client.js'))) {
    throw new Error('bundle-cli: vendored @prettier-ai/dsh-client-runtime is missing lib/client.js')
  }
}

function stampPublishedRuntimeName(packageDir: string): void {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = readJsonObject(manifestPath)
  if (manifest.name === '@prettier-ai/dsh-client-runtime') return
  manifest.name = '@prettier-ai/dsh-client-runtime'
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Copy 0.1.1-rc.2 `dsh-client-runtime` into the fat CLI when official 0.1.2
 * omitted it. Skips when `lib/client.js` is already present (0.1.1 packs).
 * @param packageDir - unpacked CLI package directory.
 * @param tarball - optional local tarball; `npm pack` when omitted.
 * @returns whether a copy was installed.
 */
export function vendorLegacyClientRuntime(packageDir: string, tarball?: string | undefined): boolean {
  const dest = join(packageDir, 'node_modules/@prettier-ai/dsh-client-runtime')
  if (existsSync(join(dest, 'lib/client.js'))) return false
  if (tarball !== undefined && tarball !== '') {
    installLegacyClientRuntimeTarball(packageDir, tarball)
    return true
  }
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-npm-pack-runtime-'))
  try {
    const packed = spawnSync('npm', ['pack', LEGACY_CLIENT_RUNTIME_SPEC, '--pack-destination', tmp], {
      encoding: 'utf8',
    })
    if (packed.status !== 0) {
      const detail = packed.stderr !== undefined && packed.stderr !== ''
        ? packed.stderr
        : packed.error instanceof Error
          ? packed.error.message
          : `status ${String(packed.status)}`
      throw new Error(`bundle-cli: npm pack ${LEGACY_CLIENT_RUNTIME_SPEC} failed: ${detail}`)
    }
    const files = readdirSync(tmp).filter(name => name.endsWith('.tgz'))
    const packedTarball = files[0]
    if (files.length !== 1 || packedTarball === undefined) {
      throw new Error(
        `bundle-cli: npm pack ${LEGACY_CLIENT_RUNTIME_SPEC} produced ${String(files.length)} tarball(s)`,
      )
    }
    installLegacyClientRuntimeTarball(packageDir, join(tmp, packedTarball))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return true
}

/**
 * Loader `entry.options.name` is still `@deepseek-ai/<name>`. Official 0.1.2
 * `nearestPackage` requires package.json `name` to match that id.
 * @param packageDir - `node_modules/@deepseek-ai/<name>`.
 * @param unscopedName - the directory name, for example `cordis`.
 */
function stampOfficialAliasName(packageDir: string, unscopedName: string): void {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = readJsonObject(manifestPath)
  const official = `@deepseek-ai/${unscopedName}`
  if (manifest.name === official) return
  manifest.name = official
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Rewrite one deploy directory and pack it as `@prettier-ai/dsh`.
 * @param packageDir - directory with package.json and production node_modules.
 * @param outDir - pack destination.
 * @param options - optional workspace (fill nested deps) and published version.
 */
export function packBundledDirectory(
  packageDir: string,
  outDir: string,
  options: PackBundledOptions = {},
): PackedIdentity {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`bundle-cli: ${manifestPath} does not exist`)
  }
  if (!existsSync(join(packageDir, 'node_modules'))) {
    throw new Error(`bundle-cli: ${packageDir} has no node_modules; pnpm deploy did not produce a bundle`)
  }
  const workspaceRoot = options.workspace
  if (workspaceRoot !== undefined && workspaceRoot !== '') {
    fillMissingWorkspacePackages(packageDir, workspaceRoot)
  }
  const nativeModules = options.nativeModules
    ?? (workspaceRoot !== undefined && workspaceRoot !== '' ? join(workspaceRoot, 'node_modules') : undefined)
  if (nativeModules !== undefined && nativeModules !== '') {
    copyNativeOptionalPackages(packageDir, nativeModules)
  }
  if (options.vendorLegacyClientRuntime === true) {
    const vendored = vendorLegacyClientRuntime(packageDir, options.legacyClientRuntimeTarball)
    if (vendored) {
      console.log(`bundle-cli: vendored @prettier-ai/dsh-client-runtime from ${LEGACY_CLIENT_RUNTIME_SPEC}`)
    }
  }
  const publishedVersion = options.version
  if (publishedVersion !== undefined && publishedVersion !== '') {
    stampPackageVersion(packageDir, publishedVersion)
  }
  const bundled = bundleCliManifest(readJsonObject(manifestPath))
  writeFileSync(manifestPath, `${JSON.stringify(bundled, null, 2)}\n`)
  materializeDeepseekAiAliases(join(packageDir, 'node_modules'))
  injectPackageDir(packageDir)
  const afterInject = readJsonObject(manifestPath)
  assertBundledCliManifest(afterInject)
  mkdirSync(outDir, { recursive: true })
  const version = packedVersion(afterInject)
  const filename = `${CLI_PACKAGE_NAME.slice(1).replace('/', '-')}-${version}.tgz`
  const file = join(outDir, filename)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-pack-'))
  try {
    const parent = join(tmp, 'parent')
    mkdirSync(parent)
    copyDereferencedSnapshot(packageDir, join(parent, 'package'))
    // Snapshot has no remaining symlinks. --hard-dereference is belt-and-suspenders
    // if a copy still shared an inode; do not --dereference (GNU tar races on
    // hoisted directory symlinks into `.pnpm`).
    execFileSync('tar', ['--hard-dereference', '-czf', file, '-C', parent, 'package'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const packed = readPackedIdentity(file)
  if (packed.name !== CLI_PACKAGE_NAME || packed.version !== version) {
    throw new Error(`bundle-cli: packed identity ${packed.name}@${packed.version}, expected ${CLI_PACKAGE_NAME}@${version}`)
  }
  assertBundledCliManifest(readPackedManifest(file))
  if (!tarballHasPathPrefix(file, 'package/node_modules/')) {
    throw new Error('bundle-cli: packed tarball is missing package/node_modules/')
  }
  if (tarballHasHardLinks(file)) {
    throw new Error('bundle-cli: packed tarball contains hard links; npm publish rejects those with E415')
  }
  if (tarballHasSymlinks(file)) {
    throw new Error('bundle-cli: packed tarball contains symbolic links; npm publish rejects those with E415')
  }
  assertPackedContainsNestedWorkspacePackages(file, packageDir, workspaceRoot)
  assertPackedContainsNativeOptionalPackages(file, packageDir)
  return { name: packed.name, version: packed.version, file }
}

/**
 * Delete any `@prettier-ai/dsh` tarball already in `directory` (not
 * `@prettier-ai/dsh-*` library tarballs). Used after `release:pack --family dsh`.
 * @param directory - pack output directory.
 */
export function removePackedCliTarballs(directory: string): readonly string[] {
  if (!existsSync(directory)) return []
  const removed: string[] = []
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
    const file = join(directory, filename)
    if (readPackedIdentity(file).name !== CLI_PACKAGE_NAME) continue
    unlinkSync(file)
    removed.push(filename)
  }
  return removed
}

/**
 * `pnpm deploy` the CLI from a rescoped, installed, built workspace, then pack.
 * @param workspace - official checkout root (after rescope + pnpm install + build).
 * @param outDir - pack destination.
 * @param replace - drop any existing `@prettier-ai/dsh` tarball in `outDir` first.
 * @param publishedVersion - optional npm version stamped only on the packed CLI.
 */
export function deployAndBundleCli(
  workspace: string,
  outDir: string,
  replace: boolean,
  publishedVersion?: string | undefined,
): PackedIdentity {
  const cliManifest = join(workspace, 'apps/cli/package.json')
  if (!existsSync(cliManifest)) {
    throw new Error(`bundle-cli: ${cliManifest} does not exist`)
  }
  const name = readJsonObject(cliManifest).name
  if (name !== CLI_PACKAGE_NAME) {
    throw new Error(`bundle-cli: apps/cli is ${JSON.stringify(name)}, expected ${JSON.stringify(CLI_PACKAGE_NAME)} (run the rescope first)`)
  }
  if (replace) removePackedCliTarballs(outDir)
  applyPnpmSupportedArchitectures(workspace)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-deploy-'))
  const packageDir = join(tmp, 'package')
  try {
    runPnpmDeploy(workspace, packageDir)
    const filled = fillMissingWorkspacePackages(packageDir, workspace)
    if (filled.length > 0) {
      console.log(`bundle-cli: filled ${String(filled.length)} missing workspace package(s): ${filled.join(', ')}`)
    }
    const natives = copyNativeOptionalPackages(packageDir, join(workspace, 'node_modules'))
    if (natives.length > 0) {
      console.log(`bundle-cli: copied ${String(natives.length)} native optional package(s)`)
    }
    return packBundledDirectory(packageDir, outDir, {
      workspace,
      version: publishedVersion,
      vendorLegacyClientRuntime: true,
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function bundledBin(bin: unknown): Record<string, string> {
  if (typeof bin === 'string') {
    if (bin !== CLI_BIN_PATH) {
      throw new Error(`bundle-cli: string bin is ${JSON.stringify(bin)}, expected ${JSON.stringify(CLI_BIN_PATH)}`)
    }
    return { [CLI_BIN_NAME]: CLI_BIN_PATH }
  }
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
    throw new Error(`bundle-cli: ${CLI_PACKAGE_NAME} is missing bin.${CLI_BIN_NAME}`)
  }
  const record = bin as Record<string, unknown>
  if (record[CLI_BIN_NAME] !== CLI_BIN_PATH) {
    throw new Error(
      `bundle-cli: bin.${CLI_BIN_NAME} is ${JSON.stringify(record[CLI_BIN_NAME])}, expected ${JSON.stringify(CLI_BIN_PATH)}`,
    )
  }
  if ('dshp' in record) {
    throw new Error('bundle-cli: @prettier-ai/dsh must not publish a dshp bin')
  }
  return { [CLI_BIN_NAME]: CLI_BIN_PATH }
}

function runPnpmDeploy(workspace: string, deployDir: string): void {
  mkdirSync(dirname(deployDir), { recursive: true })
  const result = spawnSync('pnpm', [
    '--filter', CLI_PNPM_FILTER,
    '--config.node-linker=hoisted',
    '--config.ignore-scripts=true',
    'deploy',
    '--prod',
    '--legacy',
    deployDir,
  ], {
    cwd: workspace,
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(`bundle-cli: pnpm deploy ${CLI_PNPM_FILTER} failed:\n${output}`)
  }
  if (!existsSync(join(deployDir, 'package.json'))) {
    throw new Error(`bundle-cli: pnpm deploy did not write ${join(deployDir, 'package.json')}`)
  }
  if (!existsSync(join(deployDir, 'node_modules'))) {
    throw new Error('bundle-cli: pnpm deploy produced no node_modules')
  }
}

function stampPackageVersion(packageDir: string, version: string): void {
  if (!isNpmVersion(version)) {
    throw new Error(`bundle-cli: ${JSON.stringify(version)} is not a valid npm version`)
  }
  const path = join(packageDir, 'package.json')
  const manifest = readJsonObject(path)
  manifest.version = version
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function isNpmVersion(version: string): boolean {
  return NPM_VERSION.test(version)
    && !version.includes('..')
    && !version.endsWith('.')
    && !version.endsWith('-')
    && !version.endsWith('+')
}

function readWorkspacePackageGlobs(workspaceRoot: string): string[] {
  const yamlPath = join(workspaceRoot, 'pnpm-workspace.yaml')
  if (existsSync(yamlPath)) {
    const globs = parsePnpmWorkspacePackageGlobs(readFileSync(yamlPath, 'utf8'))
    if (globs.length === 0) {
      throw new Error(`bundle-cli: ${yamlPath} has no packages: entries`)
    }
    return globs
  }
  const pkgPath = join(workspaceRoot, 'package.json')
  if (existsSync(pkgPath)) {
    const workspaces = readJsonObject(pkgPath).workspaces
    if (Array.isArray(workspaces) && workspaces.every((item): item is string => typeof item === 'string')) {
      return workspaces
    }
  }
  throw new Error(`bundle-cli: ${workspaceRoot} has no pnpm-workspace.yaml`)
}

function missingWorkspaceDeps(
  deployDir: string,
  members: ReadonlyMap<string, string>,
): string[] {
  const nodeModules = join(deployDir, 'node_modules')
  const missing: string[] = []
  const seen = new Set<string>()
  for (const manifestPath of collectDeployManifestPaths(deployDir)) {
    const manifest = readJsonObject(manifestPath)
    for (const section of INSTALL_SECTIONS) {
      for (const name of Object.keys(stringRecord(manifest[section]))) {
        if (name === CLI_PACKAGE_NAME || !members.has(name) || seen.has(name)) continue
        if (existsSync(join(nodeModules, ...name.split('/')))) continue
        seen.add(name)
        missing.push(name)
      }
    }
  }
  return missing
}

function collectDeployManifestPaths(deployDir: string): string[] {
  const paths: string[] = []
  const rootManifest = join(deployDir, 'package.json')
  if (existsSync(rootManifest)) paths.push(rootManifest)
  const nodeModules = join(deployDir, 'node_modules')
  if (existsSync(nodeModules)) walkNodeModulesForManifests(nodeModules, paths, new Set())
  return paths
}

function tryReadDirents(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
}

function walkNodeModulesForManifests(dir: string, paths: string[], seen: Set<string>): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  const entries = tryReadDirents(dir)
  if (entries === undefined) return
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      walkScopeDir(full, paths, seen)
      continue
    }
    addPackageManifest(full, paths, seen)
  }
}

function walkScopeDir(scopeDir: string, paths: string[], seen: Set<string>): void {
  const entries = tryReadDirents(scopeDir)
  if (entries === undefined) return
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    addPackageManifest(join(scopeDir, entry.name), paths, seen)
  }
}

function addPackageManifest(packageDir: string, paths: string[], seen: Set<string>): void {
  const manifest = join(packageDir, 'package.json')
  if (existsSync(manifest)) paths.push(manifest)
  const nested = join(packageDir, 'node_modules')
  if (existsSync(nested)) walkNodeModulesForManifests(nested, paths, seen)
}

function stripTopLevelYamlKey(text: string, key: string): string {
  const start = new RegExp(`^${key}:\\s*(?:#.*)?$`)
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (skipping) {
      if (/^[A-Za-z][\w-]*\s*:/.test(line)) skipping = false
      else continue
    }
    if (start.test(line)) {
      skipping = true
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function pnpmSupportedArchitecturesYaml(): string {
  const { os, cpu, libc } = PNPM_SUPPORTED_ARCHITECTURES
  return [
    'supportedArchitectures:',
    '  os:',
    ...os.map(value => `    - ${value}`),
    '  cpu:',
    ...cpu.map(value => `    - ${value}`),
    '  libc:',
    ...libc.map(value => `    - ${value}`),
  ].join('\n')
}

function collectNativeOptionalPackageDirs(nodeModulesDir: string): Map<string, string> {
  const found = new Map<string, string>()
  if (!existsSync(nodeModulesDir)) return found
  const manifests: string[] = []
  walkNodeModulesForManifests(nodeModulesDir, manifests, new Set())
  const pnpmStore = join(nodeModulesDir, '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (entry.startsWith('.')) continue
      const nested = join(pnpmStore, entry, 'node_modules')
      if (existsSync(nested)) walkNodeModulesForManifests(nested, manifests, new Set())
    }
  }
  for (const manifestPath of manifests) {
    const name = readJsonObject(manifestPath).name
    if (typeof name !== 'string' || name === '' || !isNativeOptionalPackageName(name)) continue
    if (!found.has(name)) found.set(name, dirname(manifestPath))
  }
  return found
}

/**
 * Copy `src` to `dest` as a real directory tree (follow symlinks, duplicate
 * hard-linked inodes). Used for the tar snapshot so GNU tar does not walk a
 * live pnpm hoisted graph.
 * @param src - deploy / injected package directory.
 * @param dest - empty destination path.
 */
function copyDereferencedSnapshot(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, dereference: true })
  flattenRemainingSymlinks(dest)
}

const SYMLINK_FLATTEN_PASSES = 32

/**
 * Replace leftover file and directory symlinks with real copies.
 * Node's recursive `cpSync({ dereference: true })` flattens some directory
 * links but keeps pnpm `.bin` file shims as `l` members.
 * @param root - snapshot directory.
 */
function flattenRemainingSymlinks(root: string): void {
  for (let pass = 0; pass < SYMLINK_FLATTEN_PASSES; pass += 1) {
    const links = collectSymlinkPaths(root)
    if (links.length === 0) return
    links.sort((a, b) => a.split('/').length - b.split('/').length)
    for (const linkPath of links) {
      try {
        if (!lstatSync(linkPath).isSymbolicLink()) continue
      } catch {
        continue
      }
      replaceSymlinkWithRealCopy(linkPath)
    }
  }
  const leftover = collectSymlinkPaths(root)
  if (leftover.length > 0) {
    throw new Error(`bundle-cli: snapshot still contains symlink ${leftover[0]}`)
  }
}

function collectSymlinkPaths(root: string): string[] {
  const links: string[] = []
  walkForSymlinks(root, links)
  return links
}

function walkForSymlinks(dir: string, links: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) {
      links.push(full)
      continue
    }
    if (st.isDirectory()) walkForSymlinks(full, links)
  }
}

function replaceSymlinkWithRealCopy(linkPath: string): void {
  let real: string
  try {
    real = realpathSync(linkPath)
  } catch {
    unlinkSync(linkPath)
    return
  }
  unlinkSync(linkPath)
  const st = lstatSync(real)
  if (st.isDirectory()) {
    cpSync(real, linkPath, { recursive: true, dereference: true })
    return
  }
  copyFileSync(real, linkPath)
}

function rematerializeDirectory(dir: string): void {
  const parent = dirname(dir)
  const tmp = join(parent, `${basename(dir)}.bundle-cli-real`)
  rmSync(tmp, { recursive: true, force: true })
  cpSync(dir, tmp, { recursive: true, dereference: true })
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmp, dir)
}

function copyWorkspacePackage(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter: (source: string) => basename(source) !== 'node_modules',
  })
  assertNoLinks(dest)
}

function assertNoLinks(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`bundle-cli: copied package still contains symlink ${full}`)
    }
    const stat = lstatSync(full)
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`bundle-cli: copied package still contains hardlink ${full}`)
    }
    if (entry.isDirectory()) assertNoLinks(full)
  }
}

function assertPackedContainsNativeOptionalPackages(file: string, packageDir: string): void {
  for (const name of collectNativeOptionalPackageDirs(join(packageDir, 'node_modules')).keys()) {
    const prefix = `package/node_modules/${name}/`
    if (!tarballHasPathPrefix(file, prefix)) {
      throw new Error(`bundle-cli: packed tarball is missing ${prefix}`)
    }
  }
}

function assertPackedContainsNestedWorkspacePackages(
  file: string,
  packageDir: string,
  workspaceRoot: string | undefined,
): void {
  const required = new Set<string>()
  if (workspaceRoot !== undefined && workspaceRoot !== '') {
    const members = workspacePackageLocations(workspaceRoot)
    for (const name of PACKED_NESTED_WORKSPACE_PACKAGES) {
      if (members.has(name)) required.add(name)
    }
  }
  for (const name of PACKED_NESTED_WORKSPACE_PACKAGES) {
    if (existsSync(join(packageDir, 'node_modules', ...name.split('/')))) required.add(name)
  }
  for (const name of required) {
    const prefix = `package/node_modules/${name}/`
    if (!tarballHasPathPrefix(file, prefix)) {
      throw new Error(`bundle-cli: packed tarball is missing ${prefix}`)
    }
  }
}

function packedVersion(manifest: Readonly<Record<string, unknown>>): string {
  const version = manifest.version
  if (typeof version !== 'string' || version === '') {
    throw new Error('bundle-cli: manifest lacks version')
  }
  return version
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') record[key] = entry
  }
  return record
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function readPackedManifest(tarball: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  )
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${tarball} package/package.json is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function readPackedIdentity(tarball: string): { name: string; version: string } {
  const manifest = readPackedManifest(tarball)
  const { name, version } = manifest
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error(`${tarball} manifest lacks name/version`)
  }
  return { name, version }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function pipeTarGrep(tarball: string, script: string, argv0: string, extraArgs: readonly string[] = []): boolean {
  const result = spawnSync(
    'sh',
    ['-c', script, argv0, tarball, ...extraArgs],
    { encoding: 'utf8' },
  )
  if (result.status === 0) return true
  if (result.status === 1) return false
  const detail = result.stderr !== undefined && result.stderr !== ''
    ? result.stderr
    : result.error instanceof Error
      ? result.error.message
      : `status ${String(result.status)}`
  throw new Error(`bundle-cli: tar listing failed: ${detail}`)
}

/**
 * Whether a packed tarball lists a member whose path contains `prefix`.
 * Streams `tar -tzf` through grep so a bundled CLI `node_modules` listing
 * cannot hit Node's 1 MiB spawnSync maxBuffer (`ENOBUFS`).
 * @param tarball - path to a `.tgz`.
 * @param prefix - path prefix, for example `package/node_modules/`.
 */
export function tarballHasPathPrefix(tarball: string, prefix: string): boolean {
  return pipeTarGrep(
    tarball,
    'tar -tzf "$1" | grep -F -m1 -- "$2" >/dev/null',
    'tarball-has-prefix',
    [prefix],
  )
}

/**
 * Whether GNU tar stored any hard-link members (`link to`).
 * npm publish rejects those with HTTP 415.
 * @param tarball - path to a `.tgz`.
 */
export function tarballHasHardLinks(tarball: string): boolean {
  return pipeTarGrep(
    tarball,
    'tar -tvf "$1" | grep -F -m1 -- " link to " >/dev/null',
    'tarball-has-hard-links',
  )
}

/**
 * Whether GNU tar stored any symbolic-link members (type `l`).
 * npm publish rejects those with HTTP 415 (`Symbolic link is not allowed`).
 * @param tarball - path to a `.tgz`.
 */
export function tarballHasSymlinks(tarball: string): boolean {
  return pipeTarGrep(
    tarball,
    'tar -tvf "$1" | grep -E -m1 -- "^l" >/dev/null',
    'tarball-has-symlinks',
  )
}

function main(): void {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      out: { type: 'string' },
      replace: { type: 'boolean', default: false },
      version: { type: 'string' },
      official: { type: 'string' },
      suffix: { type: 'string' },
      'npm-version': { type: 'string' },
      'published-version': { type: 'boolean', default: false },
      'apply-supported-architectures': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (values['apply-supported-architectures'] === true) {
    const workspace = values.workspace
    if (workspace === undefined || workspace === '') {
      throw new Error('bundle-cli: --apply-supported-architectures requires --workspace')
    }
    applyPnpmSupportedArchitectures(resolve(workspace))
    console.log(`bundle-cli: wrote pnpm supportedArchitectures under ${resolve(workspace)}`)
    return
  }
  if (values['published-version'] === true) {
    const official = values.official
    if (official === undefined || official === '') {
      throw new Error('bundle-cli: --published-version requires --official')
    }
    process.stdout.write(`${resolvePublishedVersion(official, {
      npmVersion: values['npm-version'],
      suffix: values.suffix,
    })}\n`)
    return
  }
  const workspace = values.workspace
  const out = values.out
  if (workspace === undefined || workspace === '' || out === undefined || out === '') {
    throw new Error('bundle-cli: --workspace <dir> and --out <dir> are required')
  }
  const packed = deployAndBundleCli(
    resolve(workspace),
    resolve(out),
    values.replace === true,
    values.version,
  )
  console.log(`bundle-cli: packed ${packed.name}@${packed.version} -> ${packed.file}`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error: unknown) {
    console.error(error)
    process.exit(1)
  }
}
