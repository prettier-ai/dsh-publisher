import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkAppliedRescope,
  checkRescope,
  OVERLAY_SCRIPT_FILES,
  rewriteFileContents,
  shouldRewritePath,
  rescopeTree,
} from './rescope-to-prettier-ai.ts'

function writeOverlayScriptFiles(dir: string): void {
  for (const file of OVERLAY_SCRIPT_FILES) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), '// overlay stub\n')
  }
}

describe('shouldRewritePath', () => {
  it('skips frozen archived notes and the overlay scripts themselves', () => {
    expect(shouldRewritePath('.agents/notes/archived/process/historical.md')).toBe(false)
    expect(shouldRewritePath('scripts/rescope-to-prettier-ai.ts')).toBe(false)
    expect(shouldRewritePath('scripts/rescope-to-prettier-ai.spec.ts')).toBe(false)
    expect(shouldRewritePath('scripts/probe-upstream-release.ts')).toBe(false)
    expect(shouldRewritePath('scripts/probe-upstream-release.spec.ts')).toBe(false)
    expect(shouldRewritePath('scripts/inject-deepseek-ai-compat.ts')).toBe(false)
    expect(shouldRewritePath('scripts/inject-deepseek-ai-compat.spec.ts')).toBe(false)
    expect(shouldRewritePath('scripts/publish-cli-tarball.ts')).toBe(false)
    expect(shouldRewritePath('scripts/publish-cli-tarball.spec.ts')).toBe(false)
  })

  it('rewrites manifests, shipped sources, release scripts, the lockfile, and pack workflows', () => {
    expect(shouldRewritePath('apps/cli/package.json')).toBe(true)
    expect(shouldRewritePath('packages/core/agent/src/index.ts')).toBe(true)
    expect(shouldRewritePath('scripts/release/families.ts')).toBe(true)
    expect(shouldRewritePath('pnpm-lock.yaml')).toBe(true)
    expect(shouldRewritePath('pnpm-workspace.yaml')).toBe(true)
    expect(shouldRewritePath('tsconfig.base.json')).toBe(true)
    expect(shouldRewritePath('.github/workflows/ci.yml')).toBe(true)
    expect(shouldRewritePath('vendor/README.md')).toBe(true)
    expect(shouldRewritePath('AGENTS.md')).toBe(true)
  })

  it('does not rewrite docs, website copy, README headings, or catalog markdown', () => {
    expect(shouldRewritePath('docs/config-catalog.md')).toBe(false)
    expect(shouldRewritePath('docs/rescope.md')).toBe(false)
    expect(shouldRewritePath('README.md')).toBe(false)
    expect(shouldRewritePath('README.zh.md')).toBe(false)
    expect(shouldRewritePath('website/AGENTS.md')).toBe(false)
    expect(shouldRewritePath('packages/core/agent/README.md')).toBe(false)
    expect(shouldRewritePath('.agents/notes/implemented/process/other.md')).toBe(false)
  })
})

describe('rewriteFileContents', () => {
  it('rewrites scoped package specifiers and leaves GitHub URLs, slugs, and bare org tokens', () => {
    const source = [
      '{"name":"@deepseek-ai/dsh","repository":{"url":"git+https://github.com/deepseek-ai/deepseek-harness.git"}}',
      'import x from "@deepseek-ai/dsh-agent"',
      'peer "@deepseek-ai"',
      'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/logo.svg',
      'https://github.com/deepseek-harness/deepseek-harness.git',
      '[catalog](../docs/tool-catalog.md#deepseek-aidsh-tool-todo)',
    ].join('\n')
    expect(rewriteFileContents('packages/core/agent/src/index.ts', source)).toBe([
      '{"name":"@prettier-ai/dsh","repository":{"url":"git+https://github.com/deepseek-ai/deepseek-harness.git"}}',
      'import x from "@prettier-ai/dsh-agent"',
      'peer "@deepseek-ai"',
      'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/logo.svg',
      'https://github.com/deepseek-harness/deepseek-harness.git',
      '[catalog](../docs/tool-catalog.md#deepseek-aidsh-tool-todo)',
    ].join('\n'))
  })

  it('rewrites regex-escaped package prefixes used in source literals', () => {
    const source = 'const MERGE_HEAD = /declare module [\'"](?:@deepseek-ai\\/cordis|\\.\\/context\\.ts)[\'"]/\n'
    expect(rewriteFileContents('scripts/cordis-walk.ts', source)).toBe(
      'const MERGE_HEAD = /declare module [\'"](?:@prettier-ai\\/cordis|\\.\\/context\\.ts)[\'"]/\n',
    )
  })

  it('is idempotent on an already-rescoped file', () => {
    const rescoped = 'import x from "@prettier-ai/dsh-agent"\n#deepseek-aidsh-tool-todo\n'
    expect(rewriteFileContents('src/index.ts', rescoped)).toBe(rescoped)
  })

  it('rewrites package.json name and leaves description product phrasing', () => {
    const source = JSON.stringify({
      name: '@deepseek-ai/dsh-agent',
      description: 'Agent interface, registry, initiator scope, and event vocabulary for the DeepSeek Harness',
      bin: { leftover: 'DeepSeekHarness' },
    }, null, 2)
    const rewritten = JSON.parse(rewriteFileContents('packages/core/agent/package.json', source)) as {
      name: string
      description: string
      bin: { leftover: string }
    }
    expect(rewritten.name).toBe('@prettier-ai/dsh-agent')
    expect(rewritten.description).toBe(
      'Agent interface, registry, initiator scope, and event vocabulary for the DeepSeek Harness',
    )
    expect(rewritten.bin.leftover).toBe('DeepSeekHarness')
  })

  it('rewrites package names quoted inside pack workflow YAML', () => {
    const source = 'run: pnpm --filter "@deepseek-ai/dsh" pack\n'
    expect(rewriteFileContents('.github/workflows/ci.yml', source)).toBe(
      'run: pnpm --filter "@prettier-ai/dsh" pack\n',
    )
  })

  it('does not rename the DeepSeekHarness TypeScript identifier', () => {
    const source = 'export class DeepSeekHarness {}\nconst scope = "@deepseek-ai/dsh"\n'
    expect(rewriteFileContents('src/api.ts', source)).toBe(
      'export class DeepSeekHarness {}\nconst scope = "@prettier-ai/dsh"\n',
    )
  })

  it('does not rewrite a root README product H1', () => {
    const source = '# DeepSeek Harness\n\ndsh is based on DeepSeek Harness (DSH).\n'
    expect(rewriteFileContents('README.md', source)).toBe(source)
  })

  it('does not rewrite a Loader cordis: builtin prefix or a github.com/deepseek-ai user-agent that is not this repository', () => {
    const source = [
      'name: cordis:include',
      "export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'",
    ].join('\n')
    expect(rewriteFileContents('packages/web/web-fetch-http/src/index.ts', source)).toBe(source)
  })
})

describe('checkRescope', () => {
  it('accepts a tree that carries the overlay scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rescope-overlay-check-'))
    writeOverlayScriptFiles(dir)
    expect(() => checkRescope(dir)).not.toThrow()
  })

  it('rejects a tree that is missing overlay scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rescope-overlay-missing-'))
    writeFileSync(join(dir, 'package.json'), '{}\n')
    expect(() => checkRescope(dir)).toThrow(/overlay:/)
  })
})

describe('rescopeTree', () => {
  it('writes eligible files, skips docs residue, and checkAppliedRescope accepts the pack-only post-state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rescope-to-prettier-ai-'))
    mkdirSync(join(dir, 'apps/cli'), { recursive: true })
    mkdirSync(join(dir, 'packages/core/agent/src'), { recursive: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    mkdirSync(join(dir, '.agents/notes/archived/process'), { recursive: true })
    writeFileSync(join(dir, 'apps/cli/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      description: 'DeepSeek Harness CLI',
      bin: { dsh: 'lib/bin.js' },
    }, null, 2))
    writeFileSync(join(dir, 'packages/core/agent/src/keep.ts'), 'export const id = "@deepseek-ai/dsh-agent"\n')
    writeFileSync(join(dir, 'docs/config-catalog.md'), 'see @deepseek-ai/dsh and #deepseek-aidsh-tool-todo\n')
    writeFileSync(join(dir, '.agents/notes/archived/process/old.md'), 'still @deepseek-ai/dsh\n')
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x40, 0x00, 0x64]))
    writeFileSync(join(dir, 'packages/core/agent/src/nul.ts'), Buffer.concat([
      Buffer.from('export const id = "@deepseek-ai/dsh-agent"\n', 'utf8'),
      Buffer.from([0]),
    ]))

    const changed = rescopeTree(dir, {
      apply: true,
      files: [
        'apps/cli/package.json',
        'packages/core/agent/src/keep.ts',
        'packages/core/agent/src/nul.ts',
        'docs/config-catalog.md',
        '.agents/notes/archived/process/old.md',
        'binary.bin',
      ],
    })
    expect(changed.map(entry => entry.file).sort()).toEqual([
      'apps/cli/package.json',
      'packages/core/agent/src/keep.ts',
      'packages/core/agent/src/nul.ts',
    ])
    expect(JSON.parse(readFileSync(join(dir, 'apps/cli/package.json'), 'utf8'))).toMatchObject({
      name: '@prettier-ai/dsh',
      description: 'DeepSeek Harness CLI',
      bin: { dsh: 'lib/bin.js' },
    })
    expect(readFileSync(join(dir, 'packages/core/agent/src/keep.ts'), 'utf8')).toBe(
      'export const id = "@prettier-ai/dsh-agent"\n',
    )
    expect(readFileSync(join(dir, 'packages/core/agent/src/nul.ts')).includes(0)).toBe(true)
    expect(readFileSync(join(dir, 'packages/core/agent/src/nul.ts'), 'utf8').startsWith(
      'export const id = "@prettier-ai/dsh-agent"\n',
    )).toBe(true)
    expect(readFileSync(join(dir, 'docs/config-catalog.md'), 'utf8')).toBe(
      'see @deepseek-ai/dsh and #deepseek-aidsh-tool-todo\n',
    )
    expect(readFileSync(join(dir, '.agents/notes/archived/process/old.md'), 'utf8')).toBe('still @deepseek-ai/dsh\n')

    expect(rescopeTree(dir, {
      apply: false,
      files: ['apps/cli/package.json', 'packages/core/agent/src/keep.ts', 'docs/config-catalog.md'],
    })).toEqual([])

    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['add', '--', 'apps/cli/package.json', 'docs/config-catalog.md'], { cwd: dir })
    expect(() => checkAppliedRescope(dir)).not.toThrow()
  })

  it('rejects checkAppliedRescope when the CLI package is still in the upstream scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rescope-to-prettier-ai-cli-'))
    mkdirSync(join(dir, 'apps/cli'), { recursive: true })
    writeFileSync(join(dir, 'apps/cli/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['add', '--', 'apps/cli/package.json'], { cwd: dir })
    expect(() => checkAppliedRescope(dir)).toThrow(/apps\/cli package name/)
  })
})
