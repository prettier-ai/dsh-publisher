import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_SCRIPT_FILES, shouldRewritePath } from './rescope-to-prettier-ai.ts'
import {
  assertRegistryHasVersion,
  cliPublishConflictMessage,
  decideCliTarballPublish,
  findCliTarball,
  publishPackedCli,
  readRegistryIntegrity,
  registryMissingAfterPublishMessage,
  tarballIntegrity,
} from './publish-cli-tarball.ts'

const VERSION = '0.1.1-rc.2'

function packManifest(parent: string, manifest: Record<string, unknown>, tarballName: string): string {
  const packageDir = join(parent, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const tarball = join(parent, tarballName)
  execFileSync('tar', ['-czf', tarball, '-C', parent, 'package'])
  return tarball
}

function packedCliDir(version = VERSION): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-publish-cli-'))
  packManifest(dir, { name: '@prettier-ai/dsh', version }, `prettier-ai-dsh-${version}.tgz`)
  return dir
}

function fetch404(): typeof fetch {
  return async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })
}

function fetchPresent(integrity: string): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ dist: { integrity } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
}

describe('decideCliTarballPublish', () => {
  const local = 'sha512-local'

  it('publishes when the version is absent', () => {
    expect(decideCliTarballPublish(local, { kind: 'absent' })).toBe('publish')
  })

  it('skips when the registry tarball has the same integrity', () => {
    expect(decideCliTarballPublish(local, { kind: 'present', integrity: local })).toBe('skip')
  })

  it('conflicts when the registry tarball differs, without inventing a version suffix', () => {
    expect(decideCliTarballPublish(local, { kind: 'present', integrity: 'sha512-other' })).toBe('conflict')
    const message = cliPublishConflictMessage('@prettier-ai/dsh', '0.1.2-alpha.1')
    expect(message).toContain('@prettier-ai/dsh@0.1.2-alpha.1')
    expect(message).toContain('does not invent a publisher-side version suffix')
    expect(message).toContain('Wait for a new official tag')
    expect(message).not.toMatch(/-\d+$/)
  })
})

describe('readRegistryIntegrity', () => {
  it('treats HTTP 404 as unpublished', async () => {
    await expect(readRegistryIntegrity('@prettier-ai/dsh', '0.1.2-alpha.1', fetch404())).resolves.toEqual({
      kind: 'absent',
    })
  })

  it('reads dist.integrity when the version exists', async () => {
    await expect(readRegistryIntegrity('@prettier-ai/dsh', '0.1.2-alpha.1', fetchPresent('sha512-abc'))).resolves.toEqual({
      kind: 'present',
      integrity: 'sha512-abc',
    })
  })
})

describe('assertRegistryHasVersion', () => {
  it('fails when GET of the version document is 404', async () => {
    await expect(assertRegistryHasVersion('@prettier-ai/dsh', VERSION, fetch404())).rejects.toThrow(
      registryMissingAfterPublishMessage('@prettier-ai/dsh', VERSION),
    )
  })

  it('accepts a version document that includes dist.integrity', async () => {
    await expect(assertRegistryHasVersion('@prettier-ai/dsh', VERSION, fetchPresent('sha512-abc'))).resolves.toBeUndefined()
  })
})

describe('publishPackedCli', () => {
  it('does not succeed when npm publish returns and the version is still absent', async () => {
    const dir = packedCliDir()
    let publishes = 0
    await expect(publishPackedCli(dir, {
      fetchImpl: fetch404(),
      publish: () => {
        publishes += 1
      },
    })).rejects.toThrow(registryMissingAfterPublishMessage('@prettier-ai/dsh', VERSION))
    expect(publishes).toBe(1)
  })

  it('logs published only after the version document exists', async () => {
    const dir = packedCliDir()
    let fetches = 0
    const fetchImpl: typeof fetch = async () => {
      fetches += 1
      if (fetches === 1) return new Response('Not Found', { status: 404, statusText: 'Not Found' })
      return new Response(JSON.stringify({ dist: { integrity: 'sha512-after' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    let publishes = 0
    await publishPackedCli(dir, {
      fetchImpl,
      publish: () => {
        publishes += 1
      },
    })
    expect(publishes).toBe(1)
    expect(fetches).toBe(2)
  })
})

describe('findCliTarball', () => {
  it('selects only @prettier-ai/dsh and ignores library tarballs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-publish-cli-'))
    packManifest(dir, { name: '@prettier-ai/dsh', version: '0.1.2-alpha.1' }, 'prettier-ai-dsh-0.1.2-alpha.1.tgz')
    const libParent = mkdtempSync(join(tmpdir(), 'dsh-publish-lib-'))
    const lib = packManifest(
      libParent,
      { name: '@prettier-ai/cordis', version: '4.0.1' },
      'prettier-ai-cordis-4.0.1.tgz',
    )
    execFileSync('cp', [lib, join(dir, 'prettier-ai-cordis-4.0.1.tgz')])
    const cli = findCliTarball(dir)
    expect(cli.name).toBe('@prettier-ai/dsh')
    expect(cli.version).toBe('0.1.2-alpha.1')
    expect(tarballIntegrity(cli.file).startsWith('sha512-')).toBe(true)
  })

  it('rejects a directory that has no CLI tarball', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-publish-empty-'))
    packManifest(dir, { name: '@prettier-ai/cordis', version: '4.0.1' }, 'prettier-ai-cordis-4.0.1.tgz')
    expect(() => findCliTarball(dir)).toThrow(/no @prettier-ai\/dsh tarball/)
  })
})

describe('Pack CLI / Publish CLI workflow', () => {
  it('is dispatch-only and publishes the CLI tarball, not the families', () => {
    const yaml = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(yaml).toContain('name: Pack CLI / Publish CLI')
    expect(yaml).toContain('workflow_dispatch:')
    expect(yaml).not.toMatch(/^\s+- cron:/m)
    expect(yaml).not.toMatch(/^\s+pnpm run release:pack --family/m)
    expect(yaml).not.toMatch(/^\s+pnpm run release:publish --family/m)
    expect(yaml).toContain('bundle-cli.ts --workspace . --out dist/npm-cli')
    expect(yaml).toContain('inject-deepseek-ai-compat.ts --check --applied --from dist/npm-cli')
    expect(yaml).toContain('publish-cli-tarball.ts --from dist/npm-cli')
  })

  it('captures CLI publish failure with || so bash $? is not zero after if !', () => {
    const yaml = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(yaml).toContain(
      'node --experimental-strip-types scripts/publish-cli-tarball.ts --from dist/npm-cli || cli_status=$?',
    )
    expect(yaml).not.toMatch(/if ! node --experimental-strip-types scripts\/publish-cli-tarball\.ts/)
    const src = readFileSync(new URL('./publish-cli-tarball.ts', import.meta.url), 'utf8')
    expect(src).toContain("stdio: 'inherit'")
    expect(src).toContain('assertRegistryHasVersion')
  })

  it('does not rewrite the publish overlay scripts themselves', () => {
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-cli-tarball.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-cli-tarball.spec.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/bundle-cli.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/bundle-cli.spec.ts')
    expect(shouldRewritePath('scripts/publish-cli-tarball.ts')).toBe(false)
    expect(shouldRewritePath('scripts/publish-cli-tarball.spec.ts')).toBe(false)
  })
})
