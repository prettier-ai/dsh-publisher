/**
 * Pack and publish the thin `@prettier-ai/dshp` wrapper.
 *
 * This package lives in this publisher repository (`packages/dshp`). It is
 * not part of the official Harness tree and must not be copied into
 * `upstream/packages/` (that workspace would pick it up). Workflows pack it
 * from this checkout after `@prettier-ai/dsh` is on npm (or already present),
 * then publish with the same integrity skip/conflict rules as
 * `publish-cli-tarball.ts`. The published bin is `dshp` only; `@prettier-ai/dsh`
 * keeps `bin.dsh`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/publish-dshp.ts --pack --version <ver> --out dist/npm-dshp
 *   node --experimental-strip-types scripts/publish-dshp.ts --from dist/npm-dshp
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  cliPublishConflictMessage,
  decideCliTarballPublish,
  readRegistryIntegrity,
  tarballIntegrity,
} from './publish-cli-tarball.ts'

export const DSHP_PACKAGE_NAME = '@prettier-ai/dshp'
export const DSH_PACKAGE_NAME = '@prettier-ai/dsh'
export const DSHP_BIN_NAME = 'dshp'
export const DSHP_BIN_PATH = 'bin.js'

const DEFAULT_SOURCE = resolve(import.meta.dirname, '../packages/dshp')

interface PackedIdentity {
  readonly name: string
  readonly version: string
  readonly file: string
}

interface DshpManifest {
  readonly name: string
  readonly version: string
  readonly bin: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
}

/**
 * Stamp `@prettier-ai/dshp` to the same version as `@prettier-ai/dsh`.
 * The committed package.json uses `0.0.0` as a placeholder.
 * @param version - exact npm version being published.
 * @param base - parsed committed manifest.
 */
export function dshpManifestFor(version: string, base: Readonly<Record<string, unknown>>): DshpManifest {
  return {
    ...base,
    name: DSHP_PACKAGE_NAME,
    version,
    bin: { [DSHP_BIN_NAME]: DSHP_BIN_PATH },
    dependencies: { [DSH_PACKAGE_NAME]: version },
  }
}

/**
 * Fail if the wrapper package is not `dshp`-only or depends on the wrong CLI.
 * @param manifest - packed or committed manifest.
 * @param version - expected version when known.
 */
export function assertDshpPackageShape(manifest: DshpManifest, version?: string): void {
  if (manifest.name !== DSHP_PACKAGE_NAME) {
    throw new Error(`publish-dshp: name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(DSHP_PACKAGE_NAME)}`)
  }
  const binKeys = Object.keys(manifest.bin)
  if (binKeys.length !== 1 || binKeys[0] !== DSHP_BIN_NAME || manifest.bin[DSHP_BIN_NAME] !== DSHP_BIN_PATH) {
    throw new Error(
      `publish-dshp: bin must be { ${DSHP_BIN_NAME}: ${JSON.stringify(DSHP_BIN_PATH)} }, got ${JSON.stringify(manifest.bin)}`,
    )
  }
  if ('dsh' in manifest.bin) {
    throw new Error('publish-dshp: @prettier-ai/dshp must not publish a dsh bin')
  }
  const dshRange = manifest.dependencies[DSH_PACKAGE_NAME]
  if (typeof dshRange !== 'string' || dshRange === '') {
    throw new Error(`publish-dshp: missing dependency ${DSH_PACKAGE_NAME}`)
  }
  if (version !== undefined && (manifest.version !== version || dshRange !== version)) {
    throw new Error(
      `publish-dshp: version/dependency must be ${version}, got version=${JSON.stringify(manifest.version)} ${DSH_PACKAGE_NAME}=${JSON.stringify(dshRange)}`,
    )
  }
}

/**
 * Find the unique `@prettier-ai/dshp` tarball in a pack directory.
 * @param directory - directory of `.tgz` files.
 */
export function findDshpTarball(directory: string): PackedIdentity {
  if (!existsSync(directory)) {
    throw new Error(`publish-dshp: ${directory} does not exist`)
  }
  const found: PackedIdentity[] = []
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
    const file = join(directory, filename)
    const identity = readPackedIdentity(file)
    if (identity.name === DSHP_PACKAGE_NAME) found.push({ ...identity, file })
  }
  if (found.length === 0) {
    throw new Error(`publish-dshp: no ${DSHP_PACKAGE_NAME} tarball in ${directory}`)
  }
  if (found.length > 1) {
    throw new Error(`publish-dshp: multiple ${DSHP_PACKAGE_NAME} tarballs in ${directory}`)
  }
  const packed = found[0]
  if (packed === undefined) throw new Error(`publish-dshp: no ${DSHP_PACKAGE_NAME} tarball in ${directory}`)
  return packed
}

/**
 * Pack `@prettier-ai/dshp` at an exact version into `--out`.
 * Copies the committed wrapper into a temp dir so this repository's
 * placeholder `0.0.0` is never mutated.
 * @param version - exact npm version (same as `@prettier-ai/dsh`).
 * @param outDir - pack destination.
 * @param sourceDir - committed package directory.
 */
export function packDshp(version: string, outDir: string, sourceDir = DEFAULT_SOURCE): PackedIdentity {
  if (version === '') {
    throw new Error('publish-dshp: --version is required')
  }
  const base = readJsonObject(join(sourceDir, 'package.json'))
  const stamped = dshpManifestFor(version, base)
  assertDshpPackageShape(stamped, version)
  const binSource = join(sourceDir, DSHP_BIN_PATH)
  if (!existsSync(binSource)) {
    throw new Error(`publish-dshp: missing ${binSource}`)
  }
  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-publish-dshp-'))
  try {
    writeFileSync(join(tmp, 'package.json'), `${JSON.stringify(stamped, null, 2)}\n`)
    const binDest = join(tmp, DSHP_BIN_PATH)
    copyFileSync(binSource, binDest)
    chmodSync(binDest, 0o755)
    execFileSync('npm', ['pack', '--pack-destination', resolve(outDir)], {
      cwd: tmp,
      encoding: 'utf8',
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const packed = findDshpTarball(outDir)
  const packedManifest = readPackedManifest(packed.file)
  assertDshpPackageShape(packedManifest, version)
  return packed
}

function readPackedManifest(tarball: string): DshpManifest {
  const parsed: unknown = JSON.parse(
    execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  )
  return asDshpManifest(parsed, tarball)
}

function asDshpManifest(parsed: unknown, label: string): DshpManifest {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const bin = record.bin
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
    throw new Error(`${label} bin must be an object`)
  }
  const binRecord: Record<string, string> = {}
  for (const [key, value] of Object.entries(bin as Record<string, unknown>)) {
    if (typeof value === 'string') binRecord[key] = value
  }
  const depsValue = record.dependencies
  const dependencies: Record<string, string> = {}
  if (depsValue !== null && typeof depsValue === 'object' && !Array.isArray(depsValue)) {
    for (const [key, value] of Object.entries(depsValue as Record<string, unknown>)) {
      if (typeof value === 'string') dependencies[key] = value
    }
  }
  if (typeof record.name !== 'string' || typeof record.version !== 'string') {
    throw new Error(`${label} lacks name/version`)
  }
  return {
    name: record.name,
    version: record.version,
    bin: binRecord,
    dependencies,
  }
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

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function publishTarball(tarball: string, version: string): void {
  const tagArgs = version.includes('-') ? ['--tag', 'next'] : []
  const result = spawnSync('npm', ['publish', tarball, '--access', 'public', ...tagArgs], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0) {
    if (output !== '') process.stdout.write(output)
    return
  }
  throw new Error(`npm publish ${tarball} failed:\n${output}`)
}

async function publishFrom(directory: string): Promise<void> {
  const packed = findDshpTarball(directory)
  const manifest = readPackedManifest(packed.file)
  assertDshpPackageShape(manifest, packed.version)
  const local = tarballIntegrity(packed.file)
  const registry = await readRegistryIntegrity(packed.name, packed.version)
  const decision = decideCliTarballPublish(local, registry)
  if (decision === 'skip') {
    console.log(`publish-dshp: ${packed.name}@${packed.version} already published with matching integrity, skipping`)
    return
  }
  if (decision === 'conflict') {
    throw new Error(cliPublishConflictMessage(packed.name, packed.version))
  }
  publishTarball(packed.file, packed.version)
  console.log(`publish-dshp: ${packed.name}@${packed.version} published`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pack: { type: 'boolean', default: false },
      version: { type: 'string' },
      out: { type: 'string' },
      from: { type: 'string' },
      source: { type: 'string' },
    },
    allowPositionals: false,
  })
  const pack = values.pack === true
  const from = values.from
  if (pack && from !== undefined && from !== '') {
    throw new Error('publish-dshp: use only one of --pack or --from')
  }
  if (pack) {
    const version = values.version
    const out = values.out
    if (version === undefined || version === '' || out === undefined || out === '') {
      throw new Error('publish-dshp: --pack requires --version and --out')
    }
    const source = values.source === undefined || values.source === '' ? DEFAULT_SOURCE : values.source
    const packed = packDshp(version, out, source)
    console.log(`publish-dshp: packed ${packed.name}@${packed.version} -> ${packed.file}`)
    return
  }
  if (from === undefined || from === '') {
    throw new Error('publish-dshp: --from <packed directory> or --pack --version --out is required')
  }
  await publishFrom(from)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
