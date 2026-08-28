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
 * `pnpm deploy` hard-links files from the content-addressable store. GNU tar
 * would store those as hard-link members, and npm then rejects the PUT with
 * `E415 Hard link is not allowed`. Pack with `--hard-dereference` so each
 * member is a regular file.
 *
 * Pack CLI #5 then failed the same PUT with `E415 Symbolic link is not
 * allowed`: `@deepseek-ai/*` aliases were relative symlinks, and leftover
 * `.bin` links are also symlink members. Copy those aliases as real
 * directories and pack with `--dereference` so remaining symlink members
 * become regular files too.
 *
 * The packed bin stays `dsh` at `lib/bin.js`. This script does not add `dshp`.
 * Host-side `@deepseek-ai/*` compatibility is applied to the deploy directory
 * (runtime loader) before packing. Install-time npm aliases are not written:
 * they would put `@prettier-ai/*` back on `dependencies`. Physical
 * `@deepseek-ai/*` directories inside bundled `node_modules` cover profile
 * `resolve.paths` instead.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bundle-cli.ts --workspace <dir> --out dist/npm-cli
 *   node --experimental-strip-types scripts/bundle-cli.ts --workspace <dir> --out dist/npm --replace
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { injectPackageDir } from './inject-deepseek-ai-compat.ts'

export const CLI_PACKAGE_NAME = '@prettier-ai/dsh'
export const CLI_BIN_NAME = 'dsh'
export const CLI_BIN_PATH = 'lib/bin.js'
export const CLI_PNPM_FILTER = './apps/cli'

const GRAPH_SCOPES = ['@prettier-ai/', '@deepseek-ai/'] as const
const INSTALL_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

interface PackedIdentity {
  readonly name: string
  readonly version: string
  readonly file: string
}

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
    else if (existsSync(dest)) continue
    cpSync(join(prettierScope, name), dest, { recursive: true, dereference: true })
    created.push(`@deepseek-ai/${name}`)
  }
  return created
}

/**
 * Rewrite one deploy directory and pack it as `@prettier-ai/dsh`.
 * @param packageDir - directory with package.json and production node_modules.
 * @param outDir - pack destination.
 */
export function packBundledDirectory(packageDir: string, outDir: string): PackedIdentity {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`bundle-cli: ${manifestPath} does not exist`)
  }
  if (!existsSync(join(packageDir, 'node_modules'))) {
    throw new Error(`bundle-cli: ${packageDir} has no node_modules; pnpm deploy did not produce a bundle`)
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
    execFileSync('cp', ['-a', packageDir, join(parent, 'package')])
    // npm rejects tar hard-link members and symlink members (both E415).
    execFileSync('tar', ['--hard-dereference', '--dereference', '-czf', file, '-C', parent, 'package'])
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
 */
export function deployAndBundleCli(workspace: string, outDir: string, replace: boolean): PackedIdentity {
  const cliManifest = join(workspace, 'apps/cli/package.json')
  if (!existsSync(cliManifest)) {
    throw new Error(`bundle-cli: ${cliManifest} does not exist`)
  }
  const name = readJsonObject(cliManifest).name
  if (name !== CLI_PACKAGE_NAME) {
    throw new Error(`bundle-cli: apps/cli is ${JSON.stringify(name)}, expected ${JSON.stringify(CLI_PACKAGE_NAME)} (run the rescope first)`)
  }
  if (replace) removePackedCliTarballs(outDir)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-deploy-'))
  const packageDir = join(tmp, 'package')
  try {
    runPnpmDeploy(workspace, packageDir)
    return packBundledDirectory(packageDir, outDir)
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
    },
    allowPositionals: false,
  })
  const workspace = values.workspace
  const out = values.out
  if (workspace === undefined || workspace === '' || out === undefined || out === '') {
    throw new Error('bundle-cli: --workspace <dir> and --out <dir> are required')
  }
  const packed = deployAndBundleCli(resolve(workspace), resolve(out), values.replace === true)
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
