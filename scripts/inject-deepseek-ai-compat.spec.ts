import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OVERLAY_SCRIPT_FILES, shouldRewritePath } from './rescope-to-prettier-ai.ts'
import {
  checkAppliedCompat,
  DEEPSEEK_AI_COMPAT_MARKER,
  deepseekAiAliasesFor,
  injectPackedDirectory,
  injectPackageDir,
  injectTarball,
  isPluginLoadingApp,
  mapDeepseekAiSpecifier,
  mergeDeepseekAiAliases,
  npmAliasFor,
  officialPluginIdentity,
  restoreOfficialPluginIdentities,
} from './inject-deepseek-ai-compat.ts'

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}


function writeBarePlugin(dir: string, name: string, id: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    type: 'module',
    exports: { '.': './index.js' },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), `export const id = ${JSON.stringify(id)}\n`)
}

function writeCliFixture(packageDir: string, options?: {
  name?: string
  dependencies?: Record<string, string>
  binSource?: string
}): void {
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: options?.name ?? '@prettier-ai/dsh',
    version: '0.1.2-alpha.1',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
    dependencies: options?.dependencies ?? {
      '@prettier-ai/cordis': '4.0.1',
      '@prettier-ai/dsh-settings': '0.1.2-alpha.1',
      commander: '^15.0.0',
    },
  }, null, 2)}\n`)
  writeFileSync(
    join(packageDir, 'lib/bin.js'),
    options?.binSource ?? '#!/usr/bin/env node\nconsole.log("upstream-cli")\n',
  )
  chmodSync(join(packageDir, 'lib/bin.js'), 0o755)
}

describe('officialPluginIdentity', () => {
  it('maps published-scope names back to official plugin ids', () => {
    expect(officialPluginIdentity('@prettier-ai/dsh-client-modules')).toBe('@deepseek-ai/dsh-client-modules')
    expect(officialPluginIdentity('@prettier-ai/dsh-client-runtime')).toBe('@deepseek-ai/dsh-client-runtime')
    expect(officialPluginIdentity('@prettier-ai/cordis/src/index.js')).toBe('@deepseek-ai/cordis/src/index.js')
  })

  it('leaves official and third-party ids unchanged', () => {
    expect(officialPluginIdentity('@deepseek-ai/dsh-client-modules')).toBe('@deepseek-ai/dsh-client-modules')
    expect(officialPluginIdentity('dshmarket')).toBe('dshmarket')
    expect(officialPluginIdentity('@dsh-ssh/dsh-ssh')).toBe('@dsh-ssh/dsh-ssh')
  })
})

describe('mapDeepseekAiSpecifier', () => {
  it('maps a scope-only package name and subpath', () => {
    expect(mapDeepseekAiSpecifier('@deepseek-ai/cordis')).toBe('@prettier-ai/cordis')
    expect(mapDeepseekAiSpecifier('@deepseek-ai/dsh-settings')).toBe('@prettier-ai/dsh-settings')
    expect(mapDeepseekAiSpecifier('@deepseek-ai/cordis/src/index.js')).toBe('@prettier-ai/cordis/src/index.js')
  })

  it('does not invent names or rewrite non-package specifiers', () => {
    expect(mapDeepseekAiSpecifier('@deepseek-ai')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('@prettier-ai/cordis')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('./@deepseek-ai/cordis')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('file:///tmp/@deepseek-ai/cordis')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('commander')).toBeUndefined()
  })

  it('does not remap profile plugins that official dsh loads by name', () => {
    expect(mapDeepseekAiSpecifier('dshmarket')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('@dsh-ssh/dsh-ssh')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('@aaravarr/dsh-subagent-max')).toBeUndefined()
    expect(mapDeepseekAiSpecifier('dsh-subagent-sidebar')).toBeUndefined()
  })
})

describe('deepseekAiAliasesFor', () => {
  it('aliases each @prettier-ai/* dependency at the same range', () => {
    expect(deepseekAiAliasesFor({
      '@prettier-ai/cordis': '4.0.1',
      '@prettier-ai/dsh-settings': 'workspace:^',
      commander: '^15.0.0',
    })).toEqual({
      '@deepseek-ai/cordis': 'npm:@prettier-ai/cordis@4.0.1',
      '@deepseek-ai/dsh-settings': 'npm:@prettier-ai/dsh-settings@workspace:^',
    })
    expect(npmAliasFor('@prettier-ai/cordis', '^4.0.1')).toBe('npm:@prettier-ai/cordis@^4.0.1')
  })

  it('is idempotent when aliases are already present at the same spec', () => {
    const deps = {
      '@prettier-ai/cordis': '4.0.1',
      '@deepseek-ai/cordis': 'npm:@prettier-ai/cordis@4.0.1',
    }
    const first = mergeDeepseekAiAliases(deps)
    expect(first.changed).toBe(false)
    expect(mergeDeepseekAiAliases(first.deps).changed).toBe(false)
    expect(first.deps['@deepseek-ai/cordis']).toBe('npm:@prettier-ai/cordis@4.0.1')
  })
})

describe('isPluginLoadingApp', () => {
  it('accepts @prettier-ai/dsh and other bins that depend on @prettier-ai/*', () => {
    expect(isPluginLoadingApp({ name: '@prettier-ai/dsh', dependencies: {} })).toBe(true)
    expect(isPluginLoadingApp({
      name: '@prettier-ai/dsh-headless',
      bin: { headless: 'lib/bin.js' },
      dependencies: { '@prettier-ai/dsh-app-boot': '0.1.2-alpha.1' },
    })).toBe(true)
  })

  it('rejects libraries without a bin', () => {
    expect(isPluginLoadingApp({
      name: '@prettier-ai/cordis',
      dependencies: { '@prettier-ai/schemastery': '3.18.1' },
    })).toBe(false)
  })
})

describe('shouldRewritePath overlay skip', () => {
  it('does not rewrite the compatibility overlay scripts themselves', () => {
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/inject-deepseek-ai-compat.ts')
    expect(OVERLAY_SCRIPT_FILES).toContain('scripts/inject-deepseek-ai-compat.spec.ts')
    expect(shouldRewritePath('scripts/inject-deepseek-ai-compat.ts')).toBe(false)
    expect(shouldRewritePath('scripts/inject-deepseek-ai-compat.spec.ts')).toBe(false)
    expect(shouldRewritePath('scripts/rescope-to-prettier-ai.ts')).toBe(false)
  })
})

describe('injectPackageDir', () => {
  it('adds aliases, wraps the bin, and is idempotent', () => {
    const dir = makeTemp('dsh-compat-pkg-')
    writeCliFixture(dir)
    const overlay = join(dir, 'scripts/inject-deepseek-ai-compat.ts')
    mkdirSync(dirname(overlay), { recursive: true })
    const overlayBody = 'const FROM = "@deepseek-ai/"\n'
    writeFileSync(overlay, overlayBody)

    const first = injectPackageDir(dir)
    expect(first.changed).toBe(true)
    expect(first.wrappedBins).toEqual(['lib/bin.js'])
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      bin: Record<string, string>
      dependencies: Record<string, string>
    }
    expect(manifest.bin).toEqual({ dsh: 'lib/bin.js' })
    expect(manifest.bin).not.toHaveProperty('dshp')
    expect(manifest.dependencies['@deepseek-ai/cordis']).toBe('npm:@prettier-ai/cordis@4.0.1')
    expect(manifest.dependencies['@deepseek-ai/dsh-settings']).toBe(
      'npm:@prettier-ai/dsh-settings@0.1.2-alpha.1',
    )
    expect(manifest.dependencies.commander).toBe('^15.0.0')
    const wrapper = readFileSync(join(dir, 'lib/bin.js'), 'utf8')
    expect(wrapper.includes(DEEPSEEK_AI_COMPAT_MARKER)).toBe(true)
    expect(wrapper).not.toMatch(/async function resolveMapped/)
    expect(wrapper).toMatch(/function resolveMapped\(/)
    expect(wrapper).toMatch(/function isHostSpecifier/)
    expect(wrapper).toMatch(/function resolveOfficialHost/)
    expect(readFileSync(join(dir, 'lib/bin.upstream.js'), 'utf8')).toContain('upstream-cli')
    const loader = readFileSync(join(dir, 'lib/deepseek-ai-compat-loader.js'), 'utf8')
    expect(loader).toContain('@deepseek-ai/')
    expect(loader).toMatch(/function isHostSpecifier/)
    expect(loader).toMatch(/function resolveOfficialHost/)
    expect(readFileSync(overlay, 'utf8')).toBe(overlayBody)

    const second = injectPackageDir(dir)
    expect(second.changed).toBe(false)
    expect(second.wrappedBins).toEqual([])
    expect(readFileSync(join(dir, 'lib/bin.js'), 'utf8')).toBe(wrapper)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin).toEqual({ dsh: 'lib/bin.js' })
  })

  it('does not rewrite a library package', () => {
    const dir = makeTemp('dsh-compat-lib-')
    mkdirSync(dir, { recursive: true })
    const manifest = {
      name: '@prettier-ai/cordis',
      version: '4.0.1',
      dependencies: { '@prettier-ai/schemastery': '3.18.1' },
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    expect(injectPackageDir(dir)).toEqual({ changed: false, wrappedBins: [] })
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(manifest)
  })
})

describe('injectTarball', () => {
  it('rewrites the packed CLI tarball and checkAppliedCompat accepts it', () => {
    const root = makeTemp('dsh-compat-tgz-')
    mkdirSync(join(root, 'package/lib'), { recursive: true })
    writeCliFixture(join(root, 'package'))
    const dist = join(root, 'dist')
    mkdirSync(dist, { recursive: true })
    execFileSync('tar', ['-czf', join(dist, 'prettier-ai-dsh-0.1.2-alpha.1.tgz'), '-C', root, 'package'])

    const libRoot = makeTemp('dsh-compat-libtgz-')
    mkdirSync(join(libRoot, 'package'), { recursive: true })
    writeFileSync(join(libRoot, 'package/package.json'), `${JSON.stringify({
      name: '@prettier-ai/cordis',
      version: '4.0.1',
      dependencies: { '@prettier-ai/schemastery': '3.18.1' },
    }, null, 2)}\n`)
    execFileSync('tar', ['-czf', join(dist, 'prettier-ai-cordis-4.0.1.tgz'), '-C', libRoot, 'package'])
    const libBefore = readFileSync(join(dist, 'prettier-ai-cordis-4.0.1.tgz'))

    const first = injectPackedDirectory(dist, true)
    expect(first.injected).toEqual(['prettier-ai-dsh-0.1.2-alpha.1.tgz'])
    expect(first.skipped).toEqual(['prettier-ai-cordis-4.0.1.tgz'])
    expect(readFileSync(join(dist, 'prettier-ai-cordis-4.0.1.tgz'))).toEqual(libBefore)
    expect(() => checkAppliedCompat(dist)).not.toThrow()
    const packedManifest = JSON.parse(
      execFileSync('tar', ['-xOzf', join(dist, 'prettier-ai-dsh-0.1.2-alpha.1.tgz'), 'package/package.json'], {
        encoding: 'utf8',
      }),
    ) as { bin: Record<string, string> }
    expect(packedManifest.bin).toEqual({ dsh: 'lib/bin.js' })
    expect(packedManifest.bin).not.toHaveProperty('dshp')

    const cliBefore = readFileSync(join(dist, 'prettier-ai-dsh-0.1.2-alpha.1.tgz'))
    const second = injectPackedDirectory(dist, true)
    expect(second.injected).toEqual(['prettier-ai-dsh-0.1.2-alpha.1.tgz'])
    expect(injectTarball(join(dist, 'prettier-ai-dsh-0.1.2-alpha.1.tgz'))).toBe(false)
    expect(readFileSync(join(dist, 'prettier-ai-dsh-0.1.2-alpha.1.tgz'))).toEqual(cliBefore)
  })

  it('does not touch overlay scripts sitting next to the pack directory', () => {
    const root = makeTemp('dsh-compat-overlay-')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'package/lib'), { recursive: true })
    const overlay = join(root, 'scripts/inject-deepseek-ai-compat.ts')
    const overlayBody = 'export const FROM = "@deepseek-ai/"\n'
    writeFileSync(overlay, overlayBody)
    writeCliFixture(join(root, 'package'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    execFileSync('tar', ['-czf', join(root, 'dist/prettier-ai-dsh-0.1.2-alpha.1.tgz'), '-C', root, 'package'])
    injectPackedDirectory(join(root, 'dist'), true)
    expect(readFileSync(overlay, 'utf8')).toBe(overlayBody)
  })
})

describe('runtime hook', () => {
  it('resolves @deepseek-ai/* from a profile-like importer to the host @prettier-ai/* package', () => {
    const root = makeTemp('dsh-compat-runtime-')
    const host = join(root, 'host')
    writeCliFixture(host, {
      binSource: [
        '#!/usr/bin/env node',
        'const plugin = process.argv[2]',
        'if (typeof plugin !== "string") throw new Error("missing plugin")',
        'await import(plugin)',
        '',
      ].join('\n'),
    })
    mkdirSync(join(host, 'node_modules/@prettier-ai/cordis'), { recursive: true })
    writeFileSync(join(host, 'node_modules/@prettier-ai/cordis/package.json'), `${JSON.stringify({
      name: '@prettier-ai/cordis',
      type: 'module',
      exports: { '.': './index.js' },
    }, null, 2)}\n`)
    writeFileSync(
      join(host, 'node_modules/@prettier-ai/cordis/index.js'),
      'export const id = "from-prettier-ai"\n',
    )
    const plugin = join(root, 'profile-plugin/index.js')
    mkdirSync(dirname(plugin), { recursive: true })
    writeFileSync(plugin, [
      'import { id } from "@deepseek-ai/cordis"',
      'if (id !== "from-prettier-ai") throw new Error(`unexpected id ${id}`)',
      'console.log(id)',
      '',
    ].join('\n'))

    injectPackageDir(host)
    expect(JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).bin).toEqual({ dsh: 'lib/bin.js' })
    const result = execFileSync(process.execPath, [join(host, 'lib/bin.js'), pathToFileURL(plugin).href], {
      encoding: 'utf8',
      cwd: join(root, 'profile-plugin'),
    })
    expect(result.trim()).toBe('from-prettier-ai')
  })

  it('loads profile plugins from DSH_HOME when the CLI is nested under dshp', () => {
    const root = makeTemp('dsh-compat-nested-')
    const dshDir = join(root, 'prefix/node_modules/@prettier-ai/dshp/node_modules/@prettier-ai/dsh')
    writeCliFixture(dshDir, {
      binSource: [
        '#!/usr/bin/env node',
        'for (const name of process.argv.slice(2)) {',
        '  const mod = await import(name)',
        '  console.log(mod.id)',
        '}',
        '',
      ].join('\n'),
    })
    mkdirSync(join(dshDir, 'node_modules/@prettier-ai/cordis'), { recursive: true })
    writeFileSync(join(dshDir, 'node_modules/@prettier-ai/cordis/package.json'), `${JSON.stringify({
      name: '@prettier-ai/cordis',
      type: 'module',
      exports: { '.': './index.js' },
    }, null, 2)}\n`)
    writeFileSync(
      join(dshDir, 'node_modules/@prettier-ai/cordis/index.js'),
      'export const id = "from-prettier-ai"\n',
    )
    writeBarePlugin(join(dshDir, 'node_modules/dshmarket'), 'dshmarket', 'from-cli-tarball')

    const dshHome = join(root, 'dsh-home')
    const profileNm = join(dshHome, 'profiles/web/node_modules')
    mkdirSync(join(dshHome, 'profiles/web'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles/web/package.json'), `${JSON.stringify({
      name: 'web',
      type: 'module',
    }, null, 2)}\n`)
    writeBarePlugin(join(profileNm, 'dshmarket'), 'dshmarket', 'from-profile-dshmarket')
    writeBarePlugin(join(profileNm, '@dsh-ssh/dsh-ssh'), '@dsh-ssh/dsh-ssh', 'from-profile-dsh-ssh')
    writeBarePlugin(join(profileNm, '@aaravarr/dsh-subagent-max'), '@aaravarr/dsh-subagent-max', 'from-profile-subagent-max')
    writeBarePlugin(join(profileNm, 'dsh-subagent-sidebar'), 'dsh-subagent-sidebar', 'from-profile-sidebar')

    injectPackageDir(dshDir)
    const wrapper = readFileSync(join(dshDir, 'lib/bin.js'), 'utf8')
    expect(wrapper).not.toMatch(/async function resolveMapped/)
    expect(wrapper).toMatch(/function resolveMapped\(/)
    expect(wrapper).toMatch(/function isHostSpecifier/)
    expect(wrapper).toContain('profileParentURLs')
    expect(JSON.parse(readFileSync(join(dshDir, 'package.json'), 'utf8')).bin).toEqual({ dsh: 'lib/bin.js' })
    expect(JSON.parse(readFileSync(join(dshDir, 'package.json'), 'utf8')).bin).not.toHaveProperty('dshp')

    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    const result = execFileSync(process.execPath, [
      join(dshDir, 'lib/bin.js'),
      'dshmarket',
      '@dsh-ssh/dsh-ssh',
      '@aaravarr/dsh-subagent-max',
      'dsh-subagent-sidebar',
      '@deepseek-ai/cordis',
    ], {
      encoding: 'utf8',
      cwd: join(root, 'elsewhere'),
      env: { ...process.env, DSH_HOME: dshHome },
    })
    expect(result.trim().split('\n')).toEqual([
      'from-profile-dshmarket',
      'from-profile-dsh-ssh',
      'from-profile-subagent-max',
      'from-profile-sidebar',
      'from-prettier-ai',
    ])
  })

  it('resolves profile-parent @prettier-ai/* from the CLI and leaves third-party plugins in the profile', () => {
    const root = makeTemp('dsh-compat-profile-parent-')
    const dshDir = join(root, 'prefix/node_modules/@prettier-ai/dsh')
    writeCliFixture(dshDir, {
      binSource: [
        '#!/usr/bin/env node',
        'const target = process.argv[2]',
        'if (typeof target !== "string") throw new Error("missing module")',
        'await import(target)',
        '',
      ].join('\n'),
    })
    writeBarePlugin(join(dshDir, 'node_modules/@prettier-ai/cordis'), '@prettier-ai/cordis', 'from-prettier-ai')
    writeBarePlugin(
      join(dshDir, 'node_modules/@prettier-ai/cordis-plugin-timer'),
      '@prettier-ai/cordis-plugin-timer',
      'from-cli-timer',
    )
    writeBarePlugin(join(dshDir, 'node_modules/dshmarket'), 'dshmarket', 'from-cli-tarball')

    const dshHome = join(root, 'dsh-home')
    const profileDir = join(dshHome, 'profiles/web')
    const profileNm = join(profileDir, 'node_modules')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'web',
      type: 'module',
    }, null, 2)}\n`)
    writeBarePlugin(join(profileNm, '@deepseek-ai/cordis'), '@deepseek-ai/cordis', 'from-official-profile')
    writeBarePlugin(join(profileNm, 'dshmarket'), 'dshmarket', 'from-profile-dshmarket')
    writeBarePlugin(join(profileNm, '@dsh-ssh/dsh-ssh'), '@dsh-ssh/dsh-ssh', 'from-profile-dsh-ssh')
    writeBarePlugin(join(profileNm, '@aaravarr/dsh-subagent-max'), '@aaravarr/dsh-subagent-max', 'from-profile-subagent-max')
    writeBarePlugin(join(profileNm, 'dsh-subagent-sidebar'), 'dsh-subagent-sidebar', 'from-profile-sidebar')
    writeFileSync(join(profileDir, 'load.js'), [
      'import { id as timer } from "@prettier-ai/cordis-plugin-timer"',
      'import { id as cordis } from "@deepseek-ai/cordis"',
      'import { id as market } from "dshmarket"',
      'import { id as ssh } from "@dsh-ssh/dsh-ssh"',
      'import { id as subagent } from "@aaravarr/dsh-subagent-max"',
      'import { id as sidebar } from "dsh-subagent-sidebar"',
      'if (timer !== "from-cli-timer") throw new Error(`timer ${timer}`)',
      'if (cordis !== "from-prettier-ai") throw new Error(`cordis ${cordis}`)',
      'if (market !== "from-profile-dshmarket") throw new Error(`market ${market}`)',
      'if (ssh !== "from-profile-dsh-ssh") throw new Error(`ssh ${ssh}`)',
      'if (subagent !== "from-profile-subagent-max") throw new Error(`subagent ${subagent}`)',
      'if (sidebar !== "from-profile-sidebar") throw new Error(`sidebar ${sidebar}`)',
      'console.log(timer)',
      'console.log(cordis)',
      'console.log(market)',
      'console.log(ssh)',
      'console.log(subagent)',
      'console.log(sidebar)',
      '',
    ].join('\n'))

    injectPackageDir(dshDir)
    const wrapper = readFileSync(join(dshDir, 'lib/bin.js'), 'utf8')
    expect(wrapper).not.toMatch(/async function resolveMapped/)
    expect(wrapper).toMatch(/function resolveMapped\(/)
    expect(wrapper).toMatch(/function isHostSpecifier/)

    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    const result = execFileSync(process.execPath, [
      join(dshDir, 'lib/bin.js'),
      pathToFileURL(join(profileDir, 'load.js')).href,
    ], {
      encoding: 'utf8',
      cwd: join(root, 'elsewhere'),
      env: { ...process.env, DSH_HOME: dshHome },
    })
    expect(result.trim().split('\n')).toEqual([
      'from-cli-timer',
      'from-prettier-ai',
      'from-profile-dshmarket',
      'from-profile-dsh-ssh',
      'from-profile-subagent-max',
      'from-profile-sidebar',
    ])
  })

  it('resolves @deepseek-ai/* from the CLI alias directory before remapping', () => {
    const root = makeTemp('dsh-compat-alias-first-')
    const host = join(root, 'host')
    writeCliFixture(host, {
      binSource: [
        '#!/usr/bin/env node',
        'const plugin = process.argv[2]',
        'if (typeof plugin !== "string") throw new Error("missing plugin")',
        'await import(plugin)',
        '',
      ].join('\n'),
    })
    writeBarePlugin(join(host, 'node_modules/@prettier-ai/cordis'), '@prettier-ai/cordis', 'from-prettier-ai')
    writeBarePlugin(join(host, 'node_modules/@deepseek-ai/cordis'), '@prettier-ai/cordis', 'from-official-alias')
    const plugin = join(root, 'profile-plugin/index.js')
    mkdirSync(dirname(plugin), { recursive: true })
    writeFileSync(plugin, [
      'import { id } from "@deepseek-ai/cordis"',
      'if (id !== "from-official-alias") throw new Error(`unexpected id ${id}`)',
      'console.log(id)',
      '',
    ].join('\n'))

    injectPackageDir(host)
    const alias = JSON.parse(
      readFileSync(join(host, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8'),
    ) as { name: string }
    expect(alias.name).toBe('@deepseek-ai/cordis')
    const result = execFileSync(process.execPath, [join(host, 'lib/bin.js'), pathToFileURL(plugin).href], {
      encoding: 'utf8',
      cwd: join(root, 'profile-plugin'),
    })
    expect(result.trim()).toBe('from-official-alias')
  })
})


function writeRescopedClientModules(packageDir: string): void {
  const published = join(packageDir, 'node_modules/@prettier-ai/dsh-client-modules')
  mkdirSync(join(published, 'lib'), { recursive: true })
  writeFileSync(join(published, 'package.json'), `${JSON.stringify({
    name: '@prettier-ai/dsh-client-modules',
    type: 'module',
    dsh: { client: { inject: ['@prettier-ai/dsh-client-runtime'] } },
  }, null, 2)}\n`)
  writeFileSync(
    join(published, 'lib/index.js'),
    [
      'export const CLIENT_MODULES_ID = "@prettier-ai/dsh-client-modules"',
      'export const CLIENT_RUNTIME_ID = "@prettier-ai/dsh-client-runtime"',
      'export const OTHER = "@prettier-ai/cordis"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(published, 'lib/client.js'),
    'window.__ModuleLoader__.load({ id: "@prettier-ai/dsh-client-modules" })\n',
  )
  const alias = join(packageDir, 'node_modules/@deepseek-ai/dsh-client-modules')
  mkdirSync(join(alias, 'lib'), { recursive: true })
  writeFileSync(join(alias, 'package.json'), `${JSON.stringify({
    name: '@prettier-ai/dsh-client-modules',
    type: 'module',
    dsh: { client: { inject: ['@prettier-ai/dsh-client-runtime'] } },
  }, null, 2)}\n`)
  writeFileSync(join(alias, 'lib/index.js'), readFileSync(join(published, 'lib/index.js')))
  writeFileSync(join(alias, 'lib/client.js'), readFileSync(join(published, 'lib/client.js')))
  const frontend = join(packageDir, 'node_modules/@prettier-ai/dsh-web-frontend/dist/assets')
  mkdirSync(frontend, { recursive: true })
  writeFileSync(
    join(packageDir, 'node_modules/@prettier-ai/dsh-web-frontend/package.json'),
    `${JSON.stringify({ name: '@prettier-ai/dsh-web-frontend' }, null, 2)}\n`,
  )
  writeFileSync(
    join(frontend, 'index.js'),
    'const PLATFORM_MODULES = { "@prettier-ai/dsh-client-modules": true }\n',
  )
}

describe('restoreOfficialPluginIdentities', () => {
  it('restores browser wire ids without renaming published-scope packages', () => {
    const dir = makeTemp('dsh-compat-restore-')
    writeCliFixture(dir)
    writeRescopedClientModules(dir)
    const paths = restoreOfficialPluginIdentities(dir)
    expect(paths.some(path => path.endsWith('dsh-client-modules/lib/index.js'))).toBe(true)
    expect(paths.some(path => path.endsWith('dsh-client-modules/lib/client.js'))).toBe(true)

    const published = JSON.parse(
      readFileSync(join(dir, 'node_modules/@prettier-ai/dsh-client-modules/package.json'), 'utf8'),
    ) as { name: string; dsh: { client: { inject: string[] } } }
    expect(published.name).toBe('@prettier-ai/dsh-client-modules')
    expect(published.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-runtime'])

    const alias = JSON.parse(
      readFileSync(join(dir, 'node_modules/@deepseek-ai/dsh-client-modules/package.json'), 'utf8'),
    ) as { name: string }
    expect(alias.name).toBe('@deepseek-ai/dsh-client-modules')

    const indexJs = readFileSync(
      join(dir, 'node_modules/@prettier-ai/dsh-client-modules/lib/index.js'),
      'utf8',
    )
    expect(indexJs).toContain('@deepseek-ai/dsh-client-modules')
    expect(indexJs).toContain('@deepseek-ai/dsh-client-runtime')
    expect(indexJs).not.toContain('@prettier-ai/dsh-client-modules')
    expect(indexJs).toContain('@prettier-ai/cordis')

    const clientJs = readFileSync(
      join(dir, 'node_modules/@prettier-ai/dsh-client-modules/lib/client.js'),
      'utf8',
    )
    expect(clientJs).toContain('@deepseek-ai/dsh-client-modules')
    expect(clientJs).not.toContain('@prettier-ai/')

    const asset = readFileSync(
      join(dir, 'node_modules/@prettier-ai/dsh-web-frontend/dist/assets/index.js'),
      'utf8',
    )
    expect(asset).toContain('@deepseek-ai/dsh-client-modules')
    expect(asset).not.toContain('@prettier-ai/')

    expect(restoreOfficialPluginIdentities(dir)).toEqual([])
  })

  it('does not rewrite the CLI package.json when only wire ids change', () => {
    const dir = makeTemp('dsh-compat-restore-manifest-')
    writeCliFixture(dir)
    const first = injectPackageDir(dir)
    expect(first.changed).toBe(true)
    const before = readFileSync(join(dir, 'package.json'))
    writeRescopedClientModules(dir)
    const second = injectPackageDir(dir)
    expect(second.changed).toBe(true)
    expect(second.wrappedBins).toEqual([])
    expect(readFileSync(join(dir, 'package.json'))).toEqual(before)
    const alias = JSON.parse(
      readFileSync(join(dir, 'node_modules/@deepseek-ai/dsh-client-modules/package.json'), 'utf8'),
    ) as { name: string }
    expect(alias.name).toBe('@deepseek-ai/dsh-client-modules')
  })
})
