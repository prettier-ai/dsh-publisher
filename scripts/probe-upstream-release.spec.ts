import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gitAuthFailed,
  gitHasTag,
  gitLsRemoteIndicatesMissing,
  isHttpNotFound,
  npmViewIndicatesMissing,
  probeUpstreamRelease,
  versionFromUpstreamTag,
} from './probe-upstream-release.ts'

describe('versionFromUpstreamTag', () => {
  it('strips the dsh family prefix and a leading v', () => {
    expect(versionFromUpstreamTag('dsh-v1.2.3')).toBe('1.2.3')
    expect(versionFromUpstreamTag('v1.2.3')).toBe('1.2.3')
    expect(versionFromUpstreamTag('1.2.3')).toBe('1.2.3')
  })
})

describe('isHttpNotFound', () => {
  it('recognizes GitHub API 404 phrasing used by fetchJson', () => {
    expect(isHttpNotFound(new Error('https://api.github.com/repos/x/y/releases/latest failed: 404 Not Found'))).toBe(true)
    expect(isHttpNotFound(new Error('404'))).toBe(true)
    expect(isHttpNotFound(new Error('Not Found'))).toBe(true)
    expect(isHttpNotFound(new Error('rate limit exceeded'))).toBe(false)
  })
})

describe('npmViewIndicatesMissing', () => {
  it('treats unpublished scoped packages as missing, not as a crash', () => {
    const unpublished = [
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/@prettier-ai%2fdsh - Not found',
      "npm error 404  '@prettier-ai/dsh@0.1.2-alpha.1' is not in this registry.",
      JSON.stringify({
        error: {
          code: 'E404',
          summary: 'Not Found - GET https://registry.npmjs.org/@prettier-ai%2fdsh - Not found',
        },
      }),
    ].join('\n')
    expect(npmViewIndicatesMissing(unpublished)).toBe(true)
  })

  it('matches npm 404 / E404 / 404 Not Found / npm error code E404', () => {
    expect(npmViewIndicatesMissing('E404')).toBe(true)
    expect(npmViewIndicatesMissing('404 Not Found')).toBe(true)
    expect(npmViewIndicatesMissing('npm error code E404')).toBe(true)
    expect(npmViewIndicatesMissing('npm ERR! code E404')).toBe(true)
    expect(npmViewIndicatesMissing('404')).toBe(true)
  })

  it('does not treat unrelated npm failures as unpublished', () => {
    expect(npmViewIndicatesMissing('npm error code EPERM')).toBe(false)
    expect(npmViewIndicatesMissing('getaddrinfo ENOTFOUND registry.npmjs.org')).toBe(false)
  })
})

describe('gitLsRemoteIndicatesMissing', () => {
  it('treats git ls-remote --exit-code 1 and 2 as an absent tag', () => {
    expect(gitLsRemoteIndicatesMissing(2)).toBe(true)
    expect(gitLsRemoteIndicatesMissing(1)).toBe(true)
    expect(gitLsRemoteIndicatesMissing(0)).toBe(false)
    expect(gitLsRemoteIndicatesMissing(128)).toBe(false)
    expect(gitLsRemoteIndicatesMissing(null)).toBe(false)
  })
})

describe('gitAuthFailed', () => {
  it('recognizes the Actions probe stderr when a Bearer extraheader is rejected', () => {
    const stderr = "fatal: could not read Username for 'https://github.com': No such device or address"
    expect(gitAuthFailed(128, stderr)).toBe(true)
    expect(gitAuthFailed(128, 'remote: invalid credentials\nfatal: Authentication failed for \'https://github.com/prettier-ai/dsh-publisher.git/\'')).toBe(true)
    expect(gitAuthFailed(2, '')).toBe(false)
    expect(gitAuthFailed(0, '')).toBe(false)
  })
})

describe('gitHasTag', () => {
  it('returns false when a local remote has no tracking tag, and true after the tag exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-publisher-git-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'probe@test.local'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'probe-test'], { cwd: dir })
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
      writeFileSync(join(dir, 'README.md'), 'test\n')
      execFileSync('git', ['add', 'README.md'], { cwd: dir })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
      expect(gitHasTag('prettier-ai/0.1.2-alpha.1', dir)).toBe(false)
      execFileSync('git', ['tag', 'prettier-ai/0.1.2-alpha.1'], { cwd: dir })
      expect(gitHasTag('prettier-ai/0.1.2-alpha.1', dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('probeUpstreamRelease', () => {
  const cliManifest = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' })).toString('base64')

  function github(tag: string): (url: string) => Promise<unknown> {
    return async (url: string) => {
      if (url.endsWith('/releases/latest') || url.includes('/releases/tags/')) {
        return { tag_name: tag, draft: false, prerelease: false }
      }
      if (url.includes('/contents/apps/cli/package.json')) {
        return { encoding: 'base64', content: cliManifest }
      }
      throw new Error(`unexpected url ${url}`)
    }
  }

  function manifest(version: string): string {
    return Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version })).toString('base64')
  }

  it('skips when npm already has the entry version', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: github('dsh-v1.2.3'),
        npmHasVersion: () => true,
        gitHasTag: () => false,
      },
    )
    expect(result).toEqual({
      action: 'skip',
      tag: 'dsh-v1.2.3',
      version: '1.2.3',
      reason: '@prettier-ai/dsh@1.2.3 is already on the npm registry',
    })
  })

  it('retries publish when the tracking tag exists but npm does not', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: github('dsh-v1.2.3'),
        npmHasVersion: () => false,
        gitHasTag: tag => tag === 'prettier-ai/1.2.3',
      },
    )
    expect(result.action).toBe('publish-only')
    expect(result.version).toBe('1.2.3')
  })

  it('syncs a new official tag', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: github('dsh-v1.2.3'),
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result).toMatchObject({
      action: 'sync',
      tag: 'dsh-v1.2.3',
      version: '1.2.3',
    })
  })

  it('skips when upstream has published no GitHub Release at all', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) return []
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result.action).toBe('skip')
    expect(result.tag).toBe('')
    expect(result.reason).toContain('no GitHub Release')
  })

  it('falls back to the newest prerelease when /releases/latest 404s', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v1.2.3-alpha.4', draft: false, prerelease: true }]
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('1.2.3-alpha.4') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result).toMatchObject({
      action: 'sync',
      tag: 'dsh-v1.2.3-alpha.4',
      version: '1.2.3-alpha.4',
    })
  })

  it('skips the newest prerelease when npm already has that version', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v1.2.3-alpha.4', draft: false, prerelease: true }]
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('1.2.3-alpha.4') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => true,
        gitHasTag: () => false,
      },
    )
    expect(result).toEqual({
      action: 'skip',
      tag: 'dsh-v1.2.3-alpha.4',
      version: '1.2.3-alpha.4',
      reason: '@prettier-ai/dsh@1.2.3-alpha.4 is already on the npm registry',
    })
  })

  it('retries publish-only for the newest prerelease when the tracking tag exists', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v1.2.3-alpha.4', draft: false, prerelease: true }]
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('1.2.3-alpha.4') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: tag => tag === 'prettier-ai/1.2.3-alpha.4',
      },
    )
    expect(result.action).toBe('publish-only')
    expect(result.version).toBe('1.2.3-alpha.4')
  })

  it('falls back when /releases/latest answers a prerelease', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) {
            return { tag_name: 'dsh-v1.2.3-alpha.0', draft: false, prerelease: true }
          }
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v1.2.3-alpha.0', draft: false, prerelease: true }]
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('1.2.3-alpha.0') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result).toMatchObject({
      action: 'sync',
      tag: 'dsh-v1.2.3-alpha.0',
      version: '1.2.3-alpha.0',
    })
  })

  it('skips when the newest listed release is a draft', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v1.2.3', draft: true, prerelease: false }]
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result.action).toBe('skip')
    expect(result.tag).toBe('')
  })

  it('accepts an operator tag that is not a GitHub Release', async () => {
    const result = await probeUpstreamRelease(
      { tag: 'dsh-v1.2.3' },
      {
        fetchJson: async (url: string) => {
          if (url.includes('/releases/tags/')) throw new Error('404 Not Found')
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: cliManifest }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result.action).toBe('sync')
    expect(result.tag).toBe('dsh-v1.2.3')
  })

  it('accepts an operator prerelease tag when named explicitly', async () => {
    const result = await probeUpstreamRelease(
      { tag: 'dsh-v1.2.3-alpha.4' },
      {
        fetchJson: async (url: string) => {
          if (url.includes('/releases/tags/')) {
            return { tag_name: 'dsh-v1.2.3-alpha.4', draft: false, prerelease: true }
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('1.2.3-alpha.4') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result.action).toBe('sync')
    expect(result.version).toBe('1.2.3-alpha.4')
  })

  it('uses the tag suffix when the contents API is missing', async () => {
    const result = await probeUpstreamRelease(
      { tag: 'dsh-v9.9.9' },
      {
        fetchJson: async (url: string) => {
          if (url.includes('/releases/tags/')) return { tag_name: 'dsh-v9.9.9', draft: false, prerelease: false }
          if (url.includes('/contents/')) throw new Error('404')
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result.version).toBe('9.9.9')
  })

  it('syncs when npm and the tracking tag are both missing (first publish)', async () => {
    const result = await probeUpstreamRelease(
      { tag: '' },
      {
        fetchJson: async (url: string) => {
          if (url.endsWith('/releases/latest')) throw new Error(`${url} failed: 404 Not Found`)
          if (url.includes('/releases?per_page=1')) {
            return [{ tag_name: 'dsh-v0.1.2-alpha.1', draft: false, prerelease: true }]
          }
          if (url.includes('/contents/apps/cli/package.json')) {
            return { encoding: 'base64', content: manifest('0.1.2-alpha.1') }
          }
          throw new Error(`unexpected url ${url}`)
        },
        npmHasVersion: () => false,
        gitHasTag: () => false,
      },
    )
    expect(result).toMatchObject({
      action: 'sync',
      tag: 'dsh-v0.1.2-alpha.1',
      version: '0.1.2-alpha.1',
    })
  })
})
