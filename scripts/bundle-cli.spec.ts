import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_SCRIPT_FILES, shouldRewritePath } from './rescope-to-prettier-ai.ts'
import { checkAppliedCompat, DEEPSEEK_AI_COMPAT_MARKER } from './inject-deepseek-ai-compat.ts'
import {
  assertBundledCliManifest,
  bundleCliManifest,
  bundledFilesField,
  CLI_BIN_NAME,
  CLI_BIN_PATH,
  CLI_PACKAGE_NAME,
  fillMissingWorkspacePackages,
  isPublishedGraphDependency,
  materializeDeepseekAiAliases,
  packBundledDirectory,
  parsePnpmWorkspacePackageGlobs,
  prettierAiDshStarDependencyNames,
  publishedNpmVersion,
  removePackedCliTarballs,
  resolvePublishedVersion,
  scopedWorkspaceDependencyNames,
  tarballHasHardLinks,
  tarballHasPathPrefix,
  tarballHasSymlinks,
} from './bundle-cli.ts'

const VERSION = '0.1.2-alpha.1'

const THIN_CLI_DEPS: Record<string, string> = {
  '@prettier-ai/cordis': '4.0.1',
  '@prettier-ai/dsh-app-boot': VERSION,
  '@prettier-ai/dsh-client-ui-conversation': VERSION,
  '@prettier-ai/dsh-settings': VERSION,
  '@deepseek-ai/cordis': 'npm:@prettier-ai/cordis@4.0.1',
  commander: '^15.0.0',
  'js-yaml': '^4.2.0',
}

function writeDeployFixture(packageDir: string, cordisDeps?: Record<string, string>): void {
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  mkdirSync(join(packageDir, 'node_modules/@prettier-ai/cordis'), { recursive: true })
  mkdirSync(join(packageDir, 'node_modules/@prettier-ai/dsh-client-ui-conversation'), { recursive: true })
  mkdirSync(join(packageDir, 'node_modules/commander'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: CLI_PACKAGE_NAME,
    version: VERSION,
    type: 'module',
    bin: { [CLI_BIN_NAME]: CLI_BIN_PATH },
    files: ['lib/*.js'],
    dependencies: THIN_CLI_DEPS,
    optionalDependencies: { '@prettier-ai/dsh-fs-local': VERSION },
    peerDependencies: { '@prettier-ai/dsh-base': VERSION },
    devDependencies: { '@prettier-ai/dsh-settings': VERSION },
  }, null, 2)}\n`)
  writeFileSync(join(packageDir, 'lib/bin.js'), '#!/usr/bin/env node\nconsole.log("upstream-cli")\n')
  chmodSync(join(packageDir, 'lib/bin.js'), 0o755)
  const cordisManifest: Record<string, unknown> = {
    name: '@prettier-ai/cordis',
    version: '4.0.1',
  }
  if (cordisDeps !== undefined) cordisManifest.dependencies = cordisDeps
  writeFileSync(
    join(packageDir, 'node_modules/@prettier-ai/cordis/package.json'),
    `${JSON.stringify(cordisManifest, null, 2)}\n`,
  )
  writeFileSync(
    join(packageDir, 'node_modules/@prettier-ai/dsh-client-ui-conversation/package.json'),
    `${JSON.stringify({ name: '@prettier-ai/dsh-client-ui-conversation', version: VERSION }, null, 2)}\n`,
  )
  writeFileSync(join(packageDir, 'node_modules/commander/package.json'), `${JSON.stringify({
    name: 'commander',
    version: '15.0.0',
  }, null, 2)}\n`)
}

/** Enough long-named members that `tar -tzf` stdout exceeds Node's 1 MiB maxBuffer. */
function writeFilesToInflateTarListing(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const pad = 'n'.repeat(200)
  for (let i = 0; i < 8000; i++) {
    writeFileSync(join(dir, `${pad}-${String(i).padStart(4, '0')}`), '')
  }
}

function writeMiniWorkspace(root: string): void {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - vendor/*',
    '  - packages/*/*',
    '  # Product assemblies over the package tier; apps/cli owns the dsh bin.',
    '  - apps/*',
    '',
    'linkWorkspacePackages: true',
    '',
  ].join('\n'))
  mkdirSync(join(root, 'apps/cli'), { recursive: true })
  mkdirSync(join(root, 'vendor/cordis'), { recursive: true })
  mkdirSync(join(root, 'vendor/cosmokit/lib'), { recursive: true })
  mkdirSync(join(root, 'vendor/schemastery'), { recursive: true })
  writeFileSync(join(root, 'apps/cli/package.json'), `${JSON.stringify({
    name: CLI_PACKAGE_NAME,
    version: VERSION,
    bin: { [CLI_BIN_NAME]: CLI_BIN_PATH },
    dependencies: { '@prettier-ai/cordis': 'workspace:^' },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'vendor/cordis/package.json'), `${JSON.stringify({
    name: '@prettier-ai/cordis',
    version: '4.0.1',
    dependencies: { '@prettier-ai/cosmokit': 'workspace:^' },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'vendor/cosmokit/package.json'), `${JSON.stringify({
    name: '@prettier-ai/cosmokit',
    version: '1.8.2',
    dependencies: { '@prettier-ai/schemastery': 'workspace:^' },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'vendor/cosmokit/lib/index.js'), 'export const ok = true\n')
  symlinkSync('index.js', join(root, 'vendor/cosmokit/lib/alias.js'))
  writeFileSync(join(root, 'vendor/schemastery/package.json'), `${JSON.stringify({
    name: '@prettier-ai/schemastery',
    version: '3.16.1',
  }, null, 2)}\n`)
}

function packThinCli(parent: string, name: string, version: string, tarballName: string): string {
  const packageDir = join(parent, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`)
  const tarball = join(parent, tarballName)
  execFileSync('tar', ['-czf', tarball, '-C', parent, 'package'])
  return tarball
}

describe('isPublishedGraphDependency', () => {
  it('treats prettier-ai, deepseek-ai, and workspace: ranges as graph edges', () => {
    expect(isPublishedGraphDependency('@prettier-ai/dsh-app-boot', VERSION)).toBe(true)
    expect(isPublishedGraphDependency('@prettier-ai/cordis', '4.0.1')).toBe(true)
    expect(isPublishedGraphDependency('@deepseek-ai/cordis', 'npm:@prettier-ai/cordis@4.0.1')).toBe(true)
    expect(isPublishedGraphDependency('leftover', 'workspace:^')).toBe(true)
    expect(isPublishedGraphDependency('commander', '^15.0.0')).toBe(false)
  })
})

describe('publishedNpmVersion', () => {
  it('keeps the official version when the suffix is empty', () => {
    expect(publishedNpmVersion('0.1.1-rc.2', undefined)).toBe('0.1.1-rc.2')
    expect(publishedNpmVersion('0.1.1-rc.2', '')).toBe('0.1.1-rc.2')
    expect(publishedNpmVersion('0.1.1', '')).toBe('0.1.1')
  })

  it('joins with a single hyphen and treats the result as a prerelease', () => {
    expect(publishedNpmVersion('0.1.1-rc.2', 'bundle.1')).toBe('0.1.1-rc.2-bundle.1')
    expect(publishedNpmVersion('0.1.1', 'bundle.1')).toBe('0.1.1-bundle.1')
    expect(publishedNpmVersion('0.1.1', 'test.2')).toBe('0.1.1-test.2')
    expect(publishedNpmVersion('0.1.1-bundle.1', undefined).includes('-')).toBe(true)
    expect(publishedNpmVersion('0.1.1', 'bundle.1').includes('-')).toBe(true)
  })

  it('rejects empty-after-trim, whitespace, slashes, and invalid identifiers', () => {
    expect(() => publishedNpmVersion('0.1.1', '  ')).toThrow(/whitespace or slashes/)
    expect(() => publishedNpmVersion('0.1.1', ' bundle.1')).toThrow(/whitespace or slashes/)
    expect(() => publishedNpmVersion('0.1.1', 'bundle.1 ')).toThrow(/whitespace or slashes/)
    expect(() => publishedNpmVersion('0.1.1', 'bundle 1')).toThrow(/whitespace or slashes/)
    expect(() => publishedNpmVersion('0.1.1', 'bundle/1')).toThrow(/whitespace or slashes/)
    expect(() => publishedNpmVersion('0.1.1', '-bundle.1')).toThrow(/prerelease identifier/)
    expect(() => publishedNpmVersion('0.1.1', 'bundle..1')).toThrow(/prerelease identifier/)
  })
})

describe('resolvePublishedVersion', () => {
  it('keeps the official version when npm_version and suffix are empty', () => {
    expect(resolvePublishedVersion('0.1.1-rc.2', {})).toBe('0.1.1-rc.2')
    expect(resolvePublishedVersion('0.1.1-rc.2', { npmVersion: '', suffix: '' })).toBe('0.1.1-rc.2')
    expect(resolvePublishedVersion('0.1.1-rc.2', { npmVersion: undefined, suffix: undefined })).toBe('0.1.1-rc.2')
  })

  it('uses npm_version as the exact published identity without appending a suffix', () => {
    expect(resolvePublishedVersion('0.1.1-rc.2', { npmVersion: '0.1.1-rc.2-bundle.1' })).toBe('0.1.1-rc.2-bundle.1')
    expect(resolvePublishedVersion('0.1.1-rc.2', {
      npmVersion: '0.1.1-rc.2-bundle.1',
      suffix: 'test.2',
    })).toBe('0.1.1-rc.2-bundle.1')
  })

  it('falls back to suffix join when npm_version is empty', () => {
    expect(resolvePublishedVersion('0.1.1-rc.2', { suffix: 'bundle.1' })).toBe('0.1.1-rc.2-bundle.1')
  })

  it('rejects invalid npm_version overrides', () => {
    expect(() => resolvePublishedVersion('0.1.1-rc.2', { npmVersion: '  ' })).toThrow(/whitespace or slashes/)
    expect(() => resolvePublishedVersion('0.1.1-rc.2', { npmVersion: 'bundle.1' })).toThrow(/valid npm version/)
    expect(() => resolvePublishedVersion('0.1.1-rc.2', { npmVersion: '0.1.1-rc.2/bundle.1' })).toThrow(/whitespace or slashes/)
  })
})

describe('parsePnpmWorkspacePackageGlobs', () => {
  it('reads official-shaped packages lists and stops at the next top-level key', () => {
    expect(parsePnpmWorkspacePackageGlobs([
      'packages:',
      '  - vendor/*',
      '  - packages/*/*',
      '  # The Landlock launcher keeps native build scripts separate.',
      '  - native/landlock-run',
      '  - native/landlock-run/packages/*',
      "  - 'apps/*'",
      '  - website',
      '',
      'linkWorkspacePackages: true',
      '',
    ].join('\n'))).toEqual([
      'vendor/*',
      'packages/*/*',
      'native/landlock-run',
      'native/landlock-run/packages/*',
      'apps/*',
      'website',
    ])
  })
})

describe('bundleCliManifest', () => {
  it('strips the workspace peer graph, keeps bin.dsh, and does not add dshp', () => {
    const bundled = bundleCliManifest({
      name: CLI_PACKAGE_NAME,
      version: VERSION,
      bin: { [CLI_BIN_NAME]: CLI_BIN_PATH },
      files: ['lib/*.js'],
      dependencies: THIN_CLI_DEPS,
      optionalDependencies: { '@prettier-ai/dsh-fs-local': VERSION },
      peerDependencies: { '@prettier-ai/dsh-base': VERSION },
      devDependencies: { typescript: '^5' },
    })
    expect(bundled.name).toBe(CLI_PACKAGE_NAME)
    expect(bundled.version).toBe(VERSION)
    expect(bundled.bin).toEqual({ [CLI_BIN_NAME]: CLI_BIN_PATH })
    expect(bundled.bin).not.toHaveProperty('dshp')
    expect(bundled.dependencies).toBeUndefined()
    expect(bundled.optionalDependencies).toBeUndefined()
    expect(bundled.peerDependencies).toBeUndefined()
    expect(bundled.devDependencies).toBeUndefined()
    expect(prettierAiDshStarDependencyNames(undefined)).toEqual([])
    expect(scopedWorkspaceDependencyNames(undefined)).toEqual([])
    expect(bundled.files).toEqual(['lib/*.js', 'node_modules'])
    expect(bundled.bundleDependencies).toBe(true)
    expect(() => assertBundledCliManifest(bundled)).not.toThrow()
  })

  it('rejects a dshp bin on the CLI package', () => {
    expect(() => bundleCliManifest({
      name: CLI_PACKAGE_NAME,
      version: VERSION,
      bin: { [CLI_BIN_NAME]: CLI_BIN_PATH, dshp: CLI_BIN_PATH },
    })).toThrow(/must not publish a dshp bin/)
  })

  it('counts @prettier-ai/dsh-* names the way a thin CLI would publish them', () => {
    expect(prettierAiDshStarDependencyNames(THIN_CLI_DEPS).sort()).toEqual([
      '@prettier-ai/dsh-app-boot',
      '@prettier-ai/dsh-client-ui-conversation',
      '@prettier-ai/dsh-settings',
    ])
    expect(prettierAiDshStarDependencyNames({ '@prettier-ai/dsh': VERSION, commander: '^15' })).toEqual([
      '@prettier-ai/dsh',
    ])
    expect(bundledFilesField(['lib/*.js'])).toEqual(['lib/*.js', 'node_modules'])
    expect(bundledFilesField(['lib/*.js', 'node_modules'])).toEqual(['lib/*.js', 'node_modules'])
  })
})

describe('fillMissingWorkspacePackages', () => {
  it('copies nested workspace deps as real directories, including transitive edges', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-bundle-ws-'))
    writeMiniWorkspace(workspace)
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-deploy-hole-'))
    writeDeployFixture(packageDir, {
      '@prettier-ai/cosmokit': 'workspace:^',
      leftover: 'workspace:^',
    })
    expect(existsSync(join(packageDir, 'node_modules/@prettier-ai/cosmokit'))).toBe(false)
    const added = [...fillMissingWorkspacePackages(packageDir, workspace)].sort()
    expect(added).toEqual(['@prettier-ai/cosmokit', '@prettier-ai/schemastery'])
    expect(existsSync(join(packageDir, 'node_modules/@prettier-ai/cosmokit/package.json'))).toBe(true)
    expect(existsSync(join(packageDir, 'node_modules/@prettier-ai/schemastery/package.json'))).toBe(true)
    expect(existsSync(join(packageDir, 'node_modules/leftover'))).toBe(false)
    expect(lstatSync(join(packageDir, 'node_modules/@prettier-ai/cosmokit/lib/alias.js')).isSymbolicLink()).toBe(false)
    expect(fillMissingWorkspacePackages(packageDir, workspace)).toEqual([])
  })
})

describe('packBundledDirectory', () => {
  it('packs node_modules, empty graph deps, wrapped bin, and @deepseek-ai aliases', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-pkg-'))
    writeDeployFixture(packageDir)
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-out-'))
    const packed = packBundledDirectory(packageDir, out)
    expect(packed.name).toBe(CLI_PACKAGE_NAME)
    expect(packed.version).toBe(VERSION)
    expect(packed.file).toBe(join(out, `prettier-ai-dsh-${VERSION}.tgz`))

    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', packed.file, 'package/package.json'], { encoding: 'utf8' }),
    ) as {
      name: string
      version: string
      bin: Record<string, string>
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      files: string[]
    }
    expect(manifest.name).toBe(CLI_PACKAGE_NAME)
    expect(manifest.bin).toEqual({ [CLI_BIN_NAME]: CLI_BIN_PATH })
    expect(manifest.bin).not.toHaveProperty('dshp')
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    expect(prettierAiDshStarDependencyNames(manifest.dependencies)).toEqual([])
    expect(scopedWorkspaceDependencyNames(manifest.dependencies)).toEqual([])
    expect(manifest.files).toContain('node_modules')

    const listing = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    expect(listing).toContain('package/node_modules/@prettier-ai/cordis/package.json')
    expect(listing).toContain('package/node_modules/@prettier-ai/dsh-client-ui-conversation/package.json')
    expect(listing).toContain('package/node_modules/@deepseek-ai/cordis/package.json')
    expect(listing).toContain('package/lib/bin.js')
    expect(listing).toContain('package/lib/bin.upstream.js')
    expect(listing).toContain('package/lib/deepseek-ai-compat-loader.js')
    expect(tarballHasHardLinks(packed.file)).toBe(false)
    expect(tarballHasSymlinks(packed.file)).toBe(false)

    const aliasManifest = JSON.parse(
      execFileSync('tar', ['-xOzf', packed.file, 'package/node_modules/@deepseek-ai/cordis/package.json'], {
        encoding: 'utf8',
      }),
    ) as { name: string }
    expect(aliasManifest.name).toBe('@prettier-ai/cordis')
    const requireFromBundle = createRequire(join(packageDir, 'package.json'))
    expect(requireFromBundle.resolve('@deepseek-ai/cordis/package.json')).toBe(
      join(packageDir, 'node_modules/@deepseek-ai/cordis/package.json'),
    )
    expect(lstatSync(join(packageDir, 'node_modules/@deepseek-ai/cordis')).isSymbolicLink()).toBe(false)

    const wrapper = execFileSync('tar', ['-xOzf', packed.file, 'package/lib/bin.js'], { encoding: 'utf8' })
    expect(wrapper).toContain(DEEPSEEK_AI_COMPAT_MARKER)
    expect(() => checkAppliedCompat(out)).not.toThrow()
  })

  it('keeps the official packed identity when no version override is set', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-official-'))
    writeDeployFixture(packageDir)
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-official-out-'))
    const packed = packBundledDirectory(packageDir, out)
    expect(packed.version).toBe(VERSION)
    expect(packed.file).toBe(join(out, `prettier-ai-dsh-${VERSION}.tgz`))
  })

  it('rewrites only the packed CLI version when npm_version is set', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-npmver-'))
    writeDeployFixture(packageDir)
    const published = '0.1.1-rc.2-bundle.1'
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-npmver-out-'))
    const packed = packBundledDirectory(packageDir, out, { version: published })
    expect(packed.version).toBe(published)
    expect(packed.file).toBe(join(out, `prettier-ai-dsh-${published}.tgz`))
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', packed.file, 'package/package.json'], { encoding: 'utf8' }),
    ) as { version: string; dependencies?: Record<string, string> }
    expect(manifest.version).toBe(published)
    expect(manifest.dependencies).toBeUndefined()
  })

  it('does not put @prettier-ai/dsh-* back when the compatibility inject runs', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-inject-'))
    writeDeployFixture(packageDir)
    packBundledDirectory(packageDir, mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-inject-out-')))
    const written = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      bin: Record<string, string>
    }
    expect(written.bin).toEqual({ [CLI_BIN_NAME]: CLI_BIN_PATH })
    expect(prettierAiDshStarDependencyNames(written.dependencies)).toEqual([])
    expect(scopedWorkspaceDependencyNames(written.dependencies)).toEqual([])
    expect(readFileSync(join(packageDir, 'lib/bin.js'), 'utf8')).toContain(DEEPSEEK_AI_COMPAT_MARKER)
  })

  it('stores hard-linked deploy files as regular members so npm will not E415', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-hardlink-'))
    writeDeployFixture(packageDir)
    const a = join(packageDir, 'node_modules/dup-a.js')
    const b = join(packageDir, 'node_modules/dup-b.js')
    writeFileSync(a, 'same-bytes\n')
    linkSync(a, b)
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-hardlink-out-'))
    const packed = packBundledDirectory(packageDir, out)
    expect(tarballHasHardLinks(packed.file)).toBe(false)
    expect(tarballHasSymlinks(packed.file)).toBe(false)
    const listing = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    expect(listing).toContain('package/node_modules/dup-a.js')
    expect(listing).toContain('package/node_modules/dup-b.js')
    expect(listing).toContain('package/node_modules/@deepseek-ai/cordis/package.json')
  })

  it('stores leftover .bin and @deepseek-ai members as regular files so npm will not E415', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-symlink-'))
    writeDeployFixture(packageDir)
    mkdirSync(join(packageDir, 'node_modules/.bin'), { recursive: true })
    symlinkSync('../commander/package.json', join(packageDir, 'node_modules/.bin/commander'))
    mkdirSync(join(packageDir, 'node_modules/@deepseek-ai'), { recursive: true })
    symlinkSync('../@prettier-ai/cordis', join(packageDir, 'node_modules/@deepseek-ai/cordis'))
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-symlink-out-'))
    const packed = packBundledDirectory(packageDir, out)
    expect(tarballHasSymlinks(packed.file)).toBe(false)
    expect(tarballHasHardLinks(packed.file)).toBe(false)
    const listing = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    expect(listing).toContain('package/node_modules/@deepseek-ai/cordis/package.json')
    expect(listing).toContain('package/node_modules/.bin/commander')
    const verbose = execFileSync('tar', ['-tvf', packed.file], { encoding: 'utf8' })
    expect(verbose.split('\n').some(line => line.startsWith('l'))).toBe(false)
    expect(lstatSync(join(packageDir, 'node_modules/@deepseek-ai/cordis')).isSymbolicLink()).toBe(false)
  })

  it('packs a deploy tree whose tar listing exceeds Node spawnSync maxBuffer', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-enobufs-'))
    writeDeployFixture(packageDir)
    writeFilesToInflateTarListing(join(packageDir, 'node_modules'))
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-enobufs-out-'))
    const packed = packBundledDirectory(packageDir, out)
    const raw = spawnSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    expect(raw.error).toMatchObject({ code: 'ENOBUFS' })
    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/')).toBe(true)
    expect(tarballHasHardLinks(packed.file)).toBe(false)
    expect(tarballHasSymlinks(packed.file)).toBe(false)
    expect(() => checkAppliedCompat(out)).not.toThrow()
  })

  it('fills nested workspace packages into the packed tarball and stamps a published version', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-bundle-ws-pack-'))
    writeMiniWorkspace(workspace)
    const packageDir = mkdtempSync(join(tmpdir(), 'dsh-bundle-deploy-pack-'))
    writeDeployFixture(packageDir, { '@prettier-ai/cosmokit': 'workspace:^' })
    const out = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-nested-out-'))
    const published = '0.1.1-rc.2-bundle.1'
    const packed = packBundledDirectory(packageDir, out, { workspace, version: published })
    expect(packed.version).toBe(published)
    expect(packed.file).toBe(join(out, `prettier-ai-dsh-${published}.tgz`))

    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', packed.file, 'package/package.json'], { encoding: 'utf8' }),
    ) as { version: string; dependencies?: Record<string, string> }
    expect(manifest.version).toBe(published)
    expect(manifest.dependencies).toBeUndefined()
    expect(scopedWorkspaceDependencyNames(manifest.dependencies)).toEqual([])

    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/@prettier-ai/cosmokit/')).toBe(true)
    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/@prettier-ai/cosmokit/package.json')).toBe(true)
    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/@prettier-ai/schemastery/package.json')).toBe(true)
    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/@deepseek-ai/cosmokit')).toBe(true)
    expect(tarballHasPathPrefix(packed.file, 'package/node_modules/leftover')).toBe(false)
    expect(tarballHasHardLinks(packed.file)).toBe(false)
    expect(tarballHasSymlinks(packed.file)).toBe(false)
  })
})

describe('tarballHasPathPrefix', () => {
  it('returns false when the prefix is absent from a small tarball', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-prefix-'))
    const packageDir = join(root, 'package')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{}\n')
    const tarball = join(root, 'small.tgz')
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
    expect(tarballHasPathPrefix(tarball, 'package/node_modules/')).toBe(false)
    expect(tarballHasPathPrefix(tarball, 'package/package.json')).toBe(true)
  })
})

describe('tarballHasHardLinks', () => {
  it('detects GNU tar hard-link members and ignores a dereference pack', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-hl-'))
    const packageDir = join(root, 'package')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'a.txt'), 'payload\n')
    linkSync(join(packageDir, 'a.txt'), join(packageDir, 'b.txt'))
    const withLinks = join(root, 'with-links.tgz')
    execFileSync('tar', ['-czf', withLinks, '-C', root, 'package'])
    expect(tarballHasHardLinks(withLinks)).toBe(true)
    const dereferenced = join(root, 'dereferenced.tgz')
    execFileSync('tar', ['--hard-dereference', '-czf', dereferenced, '-C', root, 'package'])
    expect(tarballHasHardLinks(dereferenced)).toBe(false)
  })
})

describe('tarballHasSymlinks', () => {
  it('detects GNU tar symlink members that --hard-dereference leaves in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-sl-'))
    const packageDir = join(root, 'package')
    mkdirSync(join(packageDir, 'node_modules/@prettier-ai/cordis'), { recursive: true })
    mkdirSync(join(packageDir, 'node_modules/@deepseek-ai'), { recursive: true })
    writeFileSync(join(packageDir, 'node_modules/@prettier-ai/cordis/package.json'), '{"name":"@prettier-ai/cordis"}\n')
    symlinkSync('../@prettier-ai/cordis', join(packageDir, 'node_modules/@deepseek-ai/cordis'))
    const withLinks = join(root, 'with-symlinks.tgz')
    execFileSync('tar', ['--hard-dereference', '-czf', withLinks, '-C', root, 'package'])
    expect(tarballHasSymlinks(withLinks)).toBe(true)
    expect(tarballHasHardLinks(withLinks)).toBe(false)
    const listing = execFileSync('tar', ['-tzf', withLinks], { encoding: 'utf8' })
    expect(listing).toContain('package/node_modules/@deepseek-ai/cordis')
    expect(listing).not.toContain('package/node_modules/@deepseek-ai/cordis/package.json')
    const flattened = join(root, 'flattened.tgz')
    execFileSync('tar', ['--hard-dereference', '--dereference', '-czf', flattened, '-C', root, 'package'])
    expect(tarballHasSymlinks(flattened)).toBe(false)
    expect(execFileSync('tar', ['-tzf', flattened], { encoding: 'utf8' })).toContain(
      'package/node_modules/@deepseek-ai/cordis/package.json',
    )
  })
})

describe('materializeDeepseekAiAliases', () => {
  it('copies each @prettier-ai package under @deepseek-ai as a real directory', () => {
    const nodeModules = join(mkdtempSync(join(tmpdir(), 'dsh-bundle-alias-')), 'node_modules')
    mkdirSync(join(nodeModules, '@prettier-ai/cordis'), { recursive: true })
    mkdirSync(join(nodeModules, '@prettier-ai/dsh-settings'), { recursive: true })
    writeFileSync(join(nodeModules, '@prettier-ai/cordis/package.json'), '{"name":"@prettier-ai/cordis"}\n')
    writeFileSync(join(nodeModules, '@prettier-ai/dsh-settings/package.json'), '{"name":"@prettier-ai/dsh-settings"}\n')
    expect([...materializeDeepseekAiAliases(nodeModules)]).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-settings',
    ])
    expect(lstatSync(join(nodeModules, '@deepseek-ai/cordis')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(nodeModules, '@deepseek-ai/cordis')).isDirectory()).toBe(true)
    expect(readFileSync(join(nodeModules, '@deepseek-ai/cordis/package.json'), 'utf8')).toBe(
      '{"name":"@prettier-ai/cordis"}\n',
    )
    expect(materializeDeepseekAiAliases(nodeModules)).toEqual([])
  })

  it('replaces a leftover @deepseek-ai symlink with a real directory', () => {
    const nodeModules = join(mkdtempSync(join(tmpdir(), 'dsh-bundle-alias-rel-')), 'node_modules')
    mkdirSync(join(nodeModules, '@prettier-ai/cordis'), { recursive: true })
    mkdirSync(join(nodeModules, '@deepseek-ai'), { recursive: true })
    writeFileSync(join(nodeModules, '@prettier-ai/cordis/package.json'), '{"name":"@prettier-ai/cordis"}\n')
    symlinkSync('../@prettier-ai/cordis', join(nodeModules, '@deepseek-ai/cordis'))
    expect(lstatSync(join(nodeModules, '@deepseek-ai/cordis')).isSymbolicLink()).toBe(true)
    expect([...materializeDeepseekAiAliases(nodeModules)]).toEqual(['@deepseek-ai/cordis'])
    expect(lstatSync(join(nodeModules, '@deepseek-ai/cordis')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(nodeModules, '@deepseek-ai/cordis/package.json'), 'utf8')).toBe(
      '{"name":"@prettier-ai/cordis"}\n',
    )
  })
})

describe('removePackedCliTarballs', () => {
  it('removes only @prettier-ai/dsh and leaves library tarballs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bundle-replace-'))
    packThinCli(mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-tgz-')), CLI_PACKAGE_NAME, VERSION, 'tmp.tgz')
    const cliParent = mkdtempSync(join(tmpdir(), 'dsh-bundle-cli-tgz-'))
    const cli = packThinCli(cliParent, CLI_PACKAGE_NAME, VERSION, `prettier-ai-dsh-${VERSION}.tgz`)
    execFileSync('cp', [cli, join(dir, `prettier-ai-dsh-${VERSION}.tgz`)])
    const libParent = mkdtempSync(join(tmpdir(), 'dsh-bundle-lib-tgz-'))
    const lib = packThinCli(libParent, '@prettier-ai/dsh-settings', VERSION, `prettier-ai-dsh-settings-${VERSION}.tgz`)
    execFileSync('cp', [lib, join(dir, `prettier-ai-dsh-settings-${VERSION}.tgz`)])
    expect(removePackedCliTarballs(dir)).toEqual([`prettier-ai-dsh-${VERSION}.tgz`])
    const remaining = execFileSync('ls', [dir], { encoding: 'utf8' }).trim().split('\n')
    expect(remaining).toEqual([`prettier-ai-dsh-settings-${VERSION}.tgz`])
  })
})

describe('workflows', () => {
  it('packs a bundled CLI after install+build+rescope, then keeps inject on that tarball', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(sync).toContain('scripts/bundle-cli.ts')
    expect(sync).toContain('bundle-cli.ts --workspace . --out dist/npm --replace')
    expect(sync).toContain('inject-deepseek-ai-compat.ts --check --applied --from dist/npm')
    expect(cli).toContain('scripts/bundle-cli.ts')
    expect(cli).toContain('bundle-cli.ts --workspace . --out dist/npm-cli')
    expect(cli).toContain('inject-deepseek-ai-compat.ts --check --applied --from dist/npm-cli')
    expect(cli).not.toContain('pnpm --dir apps/cli pack')
    expect(cli).not.toMatch(/^\s+- cron:/m)
    expect(cli).not.toMatch(/^\s+pnpm run release:pack --family/m)
  })

  it('lets Pack CLI take an operator-supplied suffix and keeps Sync suffix-free', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(cli).toMatch(/^\s+suffix:\s*$/m)
    expect(cli).toContain('--published-version --official')
    expect(cli).toContain('bundle-cli.ts --workspace . --out dist/npm-cli --version')
    expect(cli).toContain('publish-dshp.ts --pack --version "${PUBLISHED_VERSION}"')
    expect(sync).not.toMatch(/^\s+suffix:\s*$/m)
    expect(sync).not.toContain('--published-version')
  })

  it('documents npm_version override for a burned registry version and keeps Sync free of it', () => {
    const sync = readFileSync(new URL('../.github/workflows/sync-upstream-release.yml', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../.github/workflows/publish-cli.yml', import.meta.url), 'utf8')
    expect(cli).toMatch(/^\s+npm_version:\s*$/m)
    expect(cli).toContain('0.1.1-rc.2-bundle.1')
    expect(cli).toContain('dsh-v0.1.1-rc.2')
    expect(cli).toContain('--npm-version')
    expect(sync).not.toMatch(/^\s+npm_version:\s*$/m)
    expect(sync).not.toContain('npm_version')
  })
})

describe('overlay skip', () => {
  it('does not rewrite the bundler overlay scripts themselves', () => {
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/bundle-cli.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/bundle-cli.spec.ts')
    expect(shouldRewritePath('scripts/bundle-cli.ts')).toBe(false)
    expect(shouldRewritePath('scripts/bundle-cli.spec.ts')).toBe(false)
  })
})

describe('wrapper still forwards argv after a bundled-shaped install', () => {
  it('spawns bin.dsh from the bundled package with the same Node and exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-wrap-'))
    const wrapperDir = join(root, 'node_modules/@prettier-ai/dshp')
    const dshDir = join(root, 'node_modules/@prettier-ai/dsh')
    mkdirSync(join(dshDir, 'lib'), { recursive: true })
    mkdirSync(join(dshDir, 'node_modules/commander'), { recursive: true })
    mkdirSync(wrapperDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), `${JSON.stringify({
      name: CLI_PACKAGE_NAME,
      version: VERSION,
      type: 'module',
      bin: { [CLI_BIN_NAME]: CLI_BIN_PATH },
    }, null, 2)}\n`)
    writeFileSync(join(dshDir, 'lib/bin.js'), [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ argv: process.argv.slice(2), execPath: process.execPath }))',
      'process.exit(7)',
      '',
    ].join('\n'))
    chmodSync(join(dshDir, 'lib/bin.js'), 0o755)
    const wrapperSource = readFileSync(new URL('../packages/dshp/bin.js', import.meta.url), 'utf8')
    writeFileSync(join(wrapperDir, 'bin.js'), wrapperSource)
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
