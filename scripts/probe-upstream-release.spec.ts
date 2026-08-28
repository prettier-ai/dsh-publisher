import { describe, expect, it } from 'vitest'
import { probeUpstreamRelease, versionFromUpstreamTag } from './probe-upstream-release.ts'

describe('versionFromUpstreamTag', () => {
  it('strips the dsh family prefix and a leading v', () => {
    expect(versionFromUpstreamTag('dsh-v1.2.3')).toBe('1.2.3')
    expect(versionFromUpstreamTag('v1.2.3')).toBe('1.2.3')
    expect(versionFromUpstreamTag('1.2.3')).toBe('1.2.3')
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
})
