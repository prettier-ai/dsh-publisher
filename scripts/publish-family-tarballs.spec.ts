import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tarballIntegrity } from './publish-cli-tarball.ts'
import {
  decideFamilyTarballPublish,
  familyPublishConflictMessage,
  listPackedTarballs,
  publishPackedFamily,
} from './publish-family-tarballs.ts'

const LOCAL = 'sha512-local'
const OTHER = 'sha512-other'

function packManifest(parent: string, manifest: Record<string, unknown>, tarballName: string): string {
  const packageDir = join(parent, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const tarball = join(parent, tarballName)
  execFileSync('tar', ['-czf', tarball, '-C', parent, 'package'])
  return tarball
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

describe('decideFamilyTarballPublish', () => {
  it('publishes when the version is absent', () => {
    expect(decideFamilyTarballPublish({
      localIntegrity: LOCAL,
      registry: { kind: 'absent' },
      onConflict: 'fail',
    })).toEqual({ kind: 'publish' })
  })

  it('skips when the registry tarball has the same integrity', () => {
    expect(decideFamilyTarballPublish({
      localIntegrity: LOCAL,
      registry: { kind: 'present', integrity: LOCAL },
      onConflict: 'fail',
    })).toEqual({ kind: 'skip', reason: 'match' })
  })

  it('skips a content clash when the policy is skip', () => {
    expect(decideFamilyTarballPublish({
      localIntegrity: LOCAL,
      registry: { kind: 'present', integrity: OTHER },
      onConflict: 'skip',
    })).toEqual({ kind: 'skip', reason: 'conflict' })
  })

  it('conflicts a content clash when the policy is fail', () => {
    expect(decideFamilyTarballPublish({
      localIntegrity: LOCAL,
      registry: { kind: 'present', integrity: OTHER },
      onConflict: 'fail',
    })).toEqual({ kind: 'conflict' })
    const message = familyPublishConflictMessage('@prettier-ai/cordis-plugin-hmr', '1.0.17')
    expect(message).toContain('@prettier-ai/cordis-plugin-hmr@1.0.17')
    expect(message).toContain('cannot overwrite')
    expect(message).toContain('--on-conflict skip')
  })
})

describe('listPackedTarballs', () => {
  it('reads every tarball in filename order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-list-'))
    packManifest(dir, { name: '@prettier-ai/cordis-plugin-hmr', version: '1.0.17' }, 'b-hmr.tgz')
    packManifest(dir, { name: '@prettier-ai/cosmokit', version: '1.8.3' }, 'a-cosmokit.tgz')
    const listed = listPackedTarballs(dir)
    expect(listed.map(entry => entry.name)).toEqual([
      '@prettier-ai/cosmokit',
      '@prettier-ai/cordis-plugin-hmr',
    ])
  })
})

describe('publishPackedFamily', () => {
  it('publishes absences and skips matching integrity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-mix-'))
    const fresh = packManifest(dir, { name: '@prettier-ai/dsh-base', version: '0.1.2-alpha.5' }, 'base.tgz')
    const reused = packManifest(
      dir,
      { name: '@prettier-ai/cordis', version: '4.0.2' },
      'cordis.tgz',
    )
    const published: string[] = []
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      if (url.includes('dsh-base')) {
        if (published.includes(fresh)) {
          return new Response(JSON.stringify({ dist: { integrity: tarballIntegrity(fresh) } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('Not Found', { status: 404, statusText: 'Not Found' })
      }
      return new Response(JSON.stringify({ dist: { integrity: tarballIntegrity(reused) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await publishPackedFamily(dir, 'fail', {
      fetchImpl,
      publish: tarball => {
        published.push(tarball)
      },
      sleep: async () => {},
    })
    expect(published).toEqual([fresh])
  })

  it('skips a reused vendor version whose bytes changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-skip-'))
    packManifest(dir, { name: '@prettier-ai/cordis-plugin-hmr', version: '1.0.17' }, 'hmr.tgz')
    let publishes = 0
    await publishPackedFamily(dir, 'skip', {
      fetchImpl: fetchPresent(OTHER),
      publish: () => {
        publishes += 1
      },
      sleep: async () => {},
    })
    expect(publishes).toBe(0)
  })

  it('fails a dsh-family version whose bytes changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-fail-'))
    packManifest(dir, { name: '@prettier-ai/dsh-base', version: '0.1.2-alpha.5' }, 'base.tgz')
    let publishes = 0
    await expect(publishPackedFamily(dir, 'fail', {
      fetchImpl: fetchPresent(OTHER),
      publish: () => {
        publishes += 1
      },
      sleep: async () => {},
    })).rejects.toThrow(familyPublishConflictMessage('@prettier-ai/dsh-base', '0.1.2-alpha.5'))
    expect(publishes).toBe(0)
  })

  it('does not succeed when npm publish returns and the version is still absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-404-'))
    packManifest(dir, { name: '@prettier-ai/dsh-base', version: '0.1.2-alpha.5' }, 'base.tgz')
    let publishes = 0
    await expect(publishPackedFamily(dir, 'fail', {
      fetchImpl: fetch404(),
      publish: () => {
        publishes += 1
      },
      sleep: async () => {},
    })).rejects.toThrow(/is not on the registry after publish/)
    expect(publishes).toBe(1)
  })

  it('waits when GET 404s after npm publish then the version document appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-family-delay-'))
    const tarball = packManifest(dir, { name: '@prettier-ai/dsh-base', version: '0.1.2-alpha.5' }, 'base.tgz')
    let fetches = 0
    const fetchImpl: typeof fetch = async () => {
      fetches += 1
      if (fetches <= 3) return new Response('Not Found', { status: 404, statusText: 'Not Found' })
      return new Response(JSON.stringify({ dist: { integrity: tarballIntegrity(tarball) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    let publishes = 0
    let waits = 0
    await publishPackedFamily(dir, 'fail', {
      fetchImpl,
      publish: () => {
        publishes += 1
      },
      sleep: async () => {
        waits += 1
      },
    })
    expect(publishes).toBe(1)
    expect(waits).toBeGreaterThan(0)
  })
})

describe('workflows', () => {
  it('publishes vendor with skip-on-conflict then dsh with fail-on-conflict', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(sync).toContain(
      'publish-family-tarballs.ts" --from dist/npm-vendor --on-conflict skip',
    )
    expect(sync).toContain(
      'publish-family-tarballs.ts" --from dist/npm --on-conflict fail',
    )
    expect(sync).toMatch(/on-conflict fail[\s\S]*publish-dshp\.ts/)
    expect(sync).not.toMatch(/^\s+pnpm run release:publish --family/m)
    expect(cli).not.toContain('publish-family-tarballs.ts')
    expect(cli).not.toMatch(/^\s+pnpm run release:publish --family/m)
  })
})
