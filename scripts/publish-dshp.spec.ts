import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_SCRIPT_FILES, shouldRewritePath } from './rescope-to-prettier-ai.ts'
import {
  assertDshpPackageShape,
  DSH_PACKAGE_NAME,
  DSHP_BIN_NAME,
  DSHP_BIN_PATH,
  DSHP_PACKAGE_NAME,
  decideDshpTarballPublish,
  dshpManifestFor,
  findDshpTarball,
  packDshp,
  publishPackedDshp,
} from './publish-dshp.ts'

const COMMITTED_DSHP = new URL('../packages/dshp/', import.meta.url)
const VERSION = '0.1.2-alpha.1'

function committedManifest(): {
  name: string
  version: string
  bin: Record<string, string>
  dependencies: Record<string, string>
} {
  return JSON.parse(readFileSync(new URL('package.json', COMMITTED_DSHP), 'utf8')) as {
    name: string
    version: string
    bin: Record<string, string>
    dependencies: Record<string, string>
  }
}

describe('committed @prettier-ai/dshp package', () => {
  it('declares only bin.dshp and depends on @prettier-ai/dsh', () => {
    const manifest = committedManifest()
    expect(manifest.name).toBe(DSHP_PACKAGE_NAME)
    expect(Object.keys(manifest.bin)).toEqual([DSHP_BIN_NAME])
    expect(manifest.bin[DSHP_BIN_NAME]).toBe(DSHP_BIN_PATH)
    expect(manifest.bin).not.toHaveProperty('dsh')
    expect(manifest.dependencies[DSH_PACKAGE_NAME]).toBe(manifest.version)
    assertDshpPackageShape(manifest, manifest.version)
  })

  it('stamps the placeholder version to the CLI version being published', () => {
    const stamped = dshpManifestFor(VERSION, committedManifest())
    expect(stamped.version).toBe(VERSION)
    expect(stamped.dependencies[DSH_PACKAGE_NAME]).toBe(VERSION)
    expect(Object.keys(stamped.bin)).toEqual([DSHP_BIN_NAME])
    assertDshpPackageShape(stamped, VERSION)
  })
})

describe('packDshp', () => {
  it('packs a tarball whose version and @prettier-ai/dsh dependency match', () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-dshp-pack-'))
    const packed = packDshp(VERSION, out)
    expect(packed.name).toBe(DSHP_PACKAGE_NAME)
    expect(packed.version).toBe(VERSION)
    expect(findDshpTarball(out).file).toBe(packed.file)
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', packed.file, 'package/package.json'], { encoding: 'utf8' }),
    ) as { name: string; version: string; bin: Record<string, string>; dependencies: Record<string, string> }
    expect(manifest.name).toBe(DSHP_PACKAGE_NAME)
    expect(manifest.version).toBe(VERSION)
    expect(manifest.bin).toEqual({ [DSHP_BIN_NAME]: DSHP_BIN_PATH })
    expect(manifest.bin).not.toHaveProperty('dsh')
    expect(Object.keys(manifest.dependencies)).toEqual([DSH_PACKAGE_NAME])
    expect(Object.keys(manifest.dependencies).filter(name => name.startsWith(`${DSH_PACKAGE_NAME}-`))).toEqual([])
    expect(manifest.dependencies[DSH_PACKAGE_NAME]).toBe(VERSION)
    const listing = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    expect(listing).toContain('package/bin.js')
  })
})

describe('dshp wrapper', () => {
  it('forwards argv to @prettier-ai/dsh bin.dsh with the same Node and exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dshp-wrap-'))
    const wrapperDir = join(root, 'node_modules/@prettier-ai/dshp')
    const dshDir = join(root, 'node_modules/@prettier-ai/dsh')
    mkdirSync(join(dshDir, 'lib'), { recursive: true })
    mkdirSync(wrapperDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), `${JSON.stringify({
      name: DSH_PACKAGE_NAME,
      version: VERSION,
      type: 'module',
      bin: { dsh: 'lib/bin.js' },
    }, null, 2)}\n`)
    writeFileSync(join(dshDir, 'lib/bin.js'), [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ argv: process.argv.slice(2), execPath: process.execPath }))',
      'process.exit(7)',
      '',
    ].join('\n'))
    chmodSync(join(dshDir, 'lib/bin.js'), 0o755)
    const wrapperSource = readFileSync(new URL('bin.js', COMMITTED_DSHP), 'utf8')
    writeFileSync(join(wrapperDir, 'bin.js'), wrapperSource)
    writeFileSync(join(wrapperDir, 'package.json'), `${JSON.stringify({
      name: DSHP_PACKAGE_NAME,
      version: VERSION,
      type: 'module',
      bin: { dshp: 'bin.js' },
      dependencies: { [DSH_PACKAGE_NAME]: VERSION },
    }, null, 2)}\n`)

    const result = spawnSync(process.execPath, [join(wrapperDir, 'bin.js'), '--help', 'foo'], {
      encoding: 'utf8',
      cwd: root,
    })
    expect(result.status).toBe(7)
    const payload = JSON.parse(result.stdout) as { argv: string[]; execPath: string }
    expect(payload.argv).toEqual(['--help', 'foo'])
    expect(payload.execPath).toBe(process.execPath)
  })
})

describe('publish skip', () => {
  it('skips when the version is already on npm, including a different integrity', () => {
    expect(decideDshpTarballPublish({ kind: 'absent' })).toBe('publish')
    expect(decideDshpTarballPublish({ kind: 'present', integrity: 'sha512-dshp' })).toBe('skip')
    expect(decideDshpTarballPublish({ kind: 'present', integrity: 'sha512-other' })).toBe('skip')
  })

  it('does not publish or fail when the registry already has this dshp version', async () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-dshp-skip-'))
    packDshp(VERSION, out)
    let publishes = 0
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ dist: { integrity: 'sha512-already' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    await publishPackedDshp(out, {
      fetchImpl,
      publish: () => {
        publishes += 1
      },
    })
    expect(publishes).toBe(0)
  })
})

describe('workflows', () => {
  it('publishes dshp from both Sync and Pack CLI / Publish CLI after the CLI', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(sync).toContain('publish-dshp.ts --pack --version')
    expect(sync).toMatch(/publish-dshp\.ts" --from/)
    expect(sync).toContain('dist/npm-dshp')
    expect(sync).toMatch(/release:publish --family dsh[\s\S]*publish-dshp\.ts/)
    expect(sync).toContain('pnpm run --config.ignore-scripts=true release:publish --family vendor')
    expect(sync).toContain('pnpm run --config.ignore-scripts=true release:publish --family dsh')
    expect(sync).toContain('NPM_CONFIG_IGNORE_SCRIPTS')
    expect(cli).toContain('publish-dshp.ts --pack --version')
    expect(cli).toMatch(/publish-dshp\.ts" --from/)
    expect(cli).toContain('bundle-cli.ts --workspace . --out dist/npm-cli')
    expect(cli).not.toContain('pnpm --dir apps/cli pack')
    expect(cli).not.toMatch(/^\s+- cron:/m)
    expect(cli).not.toMatch(/^\s+pnpm run release:pack --family/m)
    expect(cli).not.toMatch(/^\s+pnpm run release:publish --family/m)
    expect(cli).toContain('publish-cli-tarball.ts --from dist/npm-cli')
  })

  it('does not add dshp to the packed @prettier-ai/dsh bin', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(sync).not.toMatch(/apps\/cli\/package\.json/)
    expect(cli).not.toMatch(/apps\/cli\/package\.json/)
    expect(sync).not.toContain('bin.dshp')
    expect(cli).not.toContain('bin.dshp')
  })
})

describe('overlay skip', () => {
  it('does not rewrite the dshp publisher script or the committed wrapper package', () => {
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-dshp.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-dshp.spec.ts')
    expect(shouldRewritePath('scripts/publish-dshp.ts')).toBe(false)
    expect(shouldRewritePath('scripts/publish-dshp.spec.ts')).toBe(false)
    expect(shouldRewritePath('packages/dshp/package.json')).toBe(false)
    expect(shouldRewritePath('packages/dshp/bin.js')).toBe(false)
  })
})
