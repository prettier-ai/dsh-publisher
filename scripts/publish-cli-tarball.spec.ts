import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_SCRIPT_FILES, shouldRewritePath } from './rescope-to-prettier-ai.ts'
import {
  cliPublishConflictMessage,
  decideCliTarballPublish,
  findCliTarball,
  readRegistryIntegrity,
  tarballIntegrity,
} from './publish-cli-tarball.ts'

function packManifest(parent: string, manifest: Record<string, unknown>, tarballName: string): string {
  const packageDir = join(parent, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const tarball = join(parent, tarballName)
  execFileSync('tar', ['-czf', tarball, '-C', parent, 'package'])
  return tarball
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
    const fetchImpl: typeof fetch = async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })
    await expect(readRegistryIntegrity('@prettier-ai/dsh', '0.1.2-alpha.1', fetchImpl)).resolves.toEqual({
      kind: 'absent',
    })
  })

  it('reads dist.integrity when the version exists', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ dist: { integrity: 'sha512-abc' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    await expect(readRegistryIntegrity('@prettier-ai/dsh', '0.1.2-alpha.1', fetchImpl)).resolves.toEqual({
      kind: 'present',
      integrity: 'sha512-abc',
    })
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
    expect(yaml).toContain('pnpm --dir apps/cli pack')
    expect(yaml).toContain('inject-deepseek-ai-compat.ts --apply --from dist/npm-cli')
    expect(yaml).toContain('publish-cli-tarball.ts --from dist/npm-cli')
  })

  it('does not rewrite the publish overlay scripts themselves', () => {
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-cli-tarball.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/publish-cli-tarball.spec.ts')
    expect(shouldRewritePath('scripts/publish-cli-tarball.ts')).toBe(false)
    expect(shouldRewritePath('scripts/publish-cli-tarball.spec.ts')).toBe(false)
  })
})
