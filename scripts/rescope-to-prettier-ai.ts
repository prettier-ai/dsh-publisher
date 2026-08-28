/**
 * Pack-only rewrite of an official DeepSeek Harness checkout's npm package
 * prefix from `@deepseek-ai/` to `@prettier-ai/`.
 *
 * This repository never vendors the Harness tree. The sync workflow fetches an
 * official tag into the runner workspace, copies this script (and its sibling
 * overlay files) onto that checkout, and runs `--apply` there before packing
 * and publishing. The mapping replaces the delimited npm scope `@deepseek-ai/`
 * (and the regex-escaped form `@deepseek-ai\\/`) in publishable manifests,
 * shipped source specifiers, tests/gates that would otherwise break, release
 * scripts, the lockfile, and pack-related workflows. It does not restyle
 * Markdown prose, GitHub URLs, catalog slugs, product titles, or package.json
 * `description` fields, and it does not touch the upstream LICENSE, so the
 * DeepSeek copyright ships unchanged inside the published tarballs.
 *
 * Usage: `node scripts/rescope-to-prettier-ai.ts [--apply|--check|--check --applied]`
 * (Node 24 type stripping; no install required). Without a mode it reports
 * what a full apply would change. `--check` asserts the overlay files are
 * present and that a sample rewrite is defined and idempotent. `--check
 * --applied` asserts a tag checkout has already been rewritten (CLI is
 * `@prettier-ai/dsh`, family names match, a second apply is a no-op).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, globSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const FROM_SCOPE = '@deepseek-ai/'
const TO_SCOPE = '@prettier-ai/'
const FROM_SCOPE_ESCAPED = '@deepseek-ai\\/'
const TO_SCOPE_ESCAPED = '@prettier-ai\\/'

/**
 * Files this repository copies onto a fetched official checkout before running
 * `--apply` there. They are also the paths the rewrite must never touch, since
 * they carry the pre-rescope scope tokens as data.
 */
export const OVERLAY_SCRIPT_FILES: readonly string[] = [
  'scripts/rescope-to-prettier-ai.ts',
  'scripts/rescope-to-prettier-ai.spec.ts',
  'scripts/probe-upstream-release.ts',
  'scripts/probe-upstream-release.spec.ts',
]

/** Paths the rewrite must not touch: frozen upstream history and this overlay. */
export const RESCOPE_SKIP_PREFIXES: readonly string[] = [
  '.agents/notes/archived/',
  ...OVERLAY_SCRIPT_FILES,
]

/**
 * Trees whose shipped JS, tests, gates, or pack CI would break if package names
 * changed without rewriting specifiers.
 */
export const PACK_SOURCE_PREFIXES: readonly string[] = [
  'packages/',
  'apps/',
  'vendor/',
  'native/',
  'scripts/',
  'python/',
  'snapshots/',
  'website/',
]

const PACK_SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.py',
  '.jsonl',
  '.tpl',
]

/**
 * Markdown files the upstream `rescope-vendor:check` gate requires to quote the
 * published Cordis names. They are pack-gate fixtures, not a documentation
 * restyle.
 */
export const VENDOR_CHECK_MARKDOWN: readonly string[] = [
  'vendor/README.md',
  'AGENTS.md',
  'docs/cookbook/adding-a-vendored-package.md',
  'docs/cookbook/adding-a-vendored-package.zh.md',
  'packages/examples/agent-spine-demo/README.md',
  'packages/examples/agent-spine-demo/README.zh.md',
]

const DSH_FAMILY_PATTERNS = ['packages/!(experimental)/*/package.json', 'apps/*/package.json'] as const
const VENDOR_FAMILY_PATTERNS = ['vendor/*/package.json'] as const
const LANDLOCK_FAMILY_PATTERNS = [
  'native/landlock-run/packages/*/package.json',
  'native/landlock-run/package.json',
] as const

const TSCONFIG_BASENAME = /^tsconfig(\..+)?\.json$/

/**
 * Whether a tracked path is eligible for the pack-only scope rewrite.
 * @param relativePath - repository-relative path from `git ls-files`.
 * @returns False for docs/README restyle targets, frozen notes, this overlay, and non-files.
 */
export function shouldRewritePath(relativePath: string): boolean {
  if (relativePath === '') return false
  if (RESCOPE_SKIP_PREFIXES.some(prefix => relativePath.startsWith(prefix))) return false
  if (VENDOR_CHECK_MARKDOWN.includes(relativePath)) return true
  if (relativePath === 'package.json' || relativePath.endsWith('/package.json')) return true
  if (relativePath === 'pnpm-lock.yaml' || relativePath === 'pnpm-workspace.yaml' || relativePath === 'knip.json') {
    return true
  }
  if (TSCONFIG_BASENAME.test(basename(relativePath))) return true
  if (
    relativePath.startsWith('.github/workflows/')
    && (relativePath.endsWith('.yml') || relativePath.endsWith('.yaml'))
  ) {
    return true
  }
  if (relativePath.endsWith('.md')) return false
  if (PACK_SOURCE_PREFIXES.some(prefix => relativePath.startsWith(prefix))) {
    return PACK_SOURCE_EXTENSIONS.some(extension => relativePath.endsWith(extension))
  }
  if (!relativePath.includes('/') && PACK_SOURCE_EXTENSIONS.some(extension => relativePath.endsWith(extension))) {
    return true
  }
  return false
}

/**
 * Rewrite one eligible file's npm scope tokens according to the pack-only mapping.
 * @param relativePath - repository-relative path, used to apply manifest-only rules.
 * @param text - UTF-8 file contents.
 * @returns The rewritten text; identical when the file is already in the post-state.
 */
export function rewriteFileContents(relativePath: string, text: string): string {
  return isPackageJson(relativePath)
    ? replaceScopeOutsideDescription(text)
    : replaceNpmScope(text)
}

function isPackageJson(relativePath: string): boolean {
  return relativePath === 'package.json' || relativePath.endsWith('/package.json')
}

/**
 * Replace `@deepseek-ai/` in a package.json file without touching `description`.
 * @param text - package.json file contents.
 * @returns Contents whose name and dependency ranges are rescoped.
 */
function replaceScopeOutsideDescription(text: string): string {
  const placeholders: string[] = []
  const masked = text.replace(/("description"\s*:\s*")((?:\\.|[^"\\])*)(")/g, (match: string) => {
    const index = placeholders.length
    placeholders.push(match)
    return `"description": "__DSH_RESCOPE_DESC_${String(index)}__"`
  })
  const rewritten = replaceNpmScope(masked)
  return rewritten.replace(/"description": "__DSH_RESCOPE_DESC_(\d+)__"/g, (_match, index: string) => {
    return placeholders[Number(index)] ?? _match
  })
}

/**
 * Replace the npm scope token and its regex-escaped form used in `/.../` literals.
 * @param text - file contents.
 * @returns Contents whose `@deepseek-ai/` and `@deepseek-ai\\/` package prefixes are `@prettier-ai`.
 */
function replaceNpmScope(text: string): string {
  return text.replaceAll(FROM_SCOPE, TO_SCOPE).replaceAll(FROM_SCOPE_ESCAPED, TO_SCOPE_ESCAPED)
}

/** One file the rewrite changed or would change. */
export interface RescopeChange {
  readonly file: string
}

/** Options for applying or checking the rewrite over a tree. */
export interface RescopeTreeOptions {
  /** Write rewritten files. When false, only report. */
  readonly apply: boolean
  /** Explicit relative paths; `git ls-files` when omitted. */
  readonly files?: readonly string[]
}

/**
 * Apply or dry-run the pack-only scope rewrite over a repository tree.
 * @param repositoryRoot - git repository root.
 * @param options - write vs report, optional path list.
 * @returns Paths whose contents would change.
 */
export function rescopeTree(repositoryRoot: string, options: RescopeTreeOptions): RescopeChange[] {
  const files = options.files === undefined ? trackedFiles(repositoryRoot) : [...options.files]
  const changed: RescopeChange[] = []
  for (const file of files) {
    if (!shouldRewritePath(file)) continue
    const path = resolve(repositoryRoot, file)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile()) continue
    const bytes = readFileSync(path)
    const before = bytes.toString('utf8')
    const after = rewriteFileContents(file, before)
    if (after === before) continue
    changed.push({ file })
    if (options.apply) writeFileSync(path, after)
  }
  return changed
}

/**
 * Assert the overlay files are present and the pack-only rewrite is defined.
 * Does not require the tree to already be renamed `@prettier-ai/*`.
 * @param repositoryRoot - git repository root.
 * @throws When overlay files are missing or the sample rewrite is missing or
 *   not idempotent.
 */
export function checkRescope(repositoryRoot: string): void {
  const failures: string[] = []
  for (const file of OVERLAY_SCRIPT_FILES) {
    if (!existsSync(resolve(repositoryRoot, file))) {
      failures.push(`overlay: missing ${file}`)
    }
  }
  const sample = '{"name":"@deepseek-ai/dsh"}\nimport x from "@deepseek-ai/dsh-agent"\n'
  const rewritten = rewriteFileContents('packages/core/agent/src/index.ts', sample)
  if (!rewritten.includes('@prettier-ai/dsh') || rewritten.includes('@deepseek-ai/dsh-agent')) {
    failures.push('overlay: sample rewrite did not map @deepseek-ai/ to @prettier-ai/')
  }
  if (rewriteFileContents('packages/core/agent/src/index.ts', rewritten) !== rewritten) {
    failures.push('overlay: sample rewrite is not idempotent')
  }
  if (failures.length > 0) {
    throw new Error(`rescope-to-prettier-ai: ${String(failures.length)} problem(s)\n${failures.join('\n')}`)
  }
}

/**
 * Assert a tag checkout has already been pack-rewritten: a further apply is a
 * no-op, the CLI package is `@prettier-ai/dsh` with a `dsh` bin, and publishable
 * family members (when present) use `@prettier-ai/`.
 * @param repositoryRoot - git repository root.
 * @throws When residue remains on eligible files or postconditions fail.
 */
export function checkAppliedRescope(repositoryRoot: string): void {
  const outstanding = rescopeTree(repositoryRoot, { apply: false })
  const failures: string[] = outstanding.map(change => `residue: ${change.file} still carries a pre-rescope token`)
  const cli = readCliManifest(repositoryRoot)
  if (cli.name !== '@prettier-ai/dsh') {
    failures.push(`postcondition: apps/cli package name is ${JSON.stringify(cli.name)}, expected "@prettier-ai/dsh"`)
  }
  if (cli.bin?.dsh !== 'lib/bin.js') {
    failures.push(`postcondition: apps/cli bin.dsh is ${JSON.stringify(cli.bin?.dsh)}, expected "lib/bin.js"`)
  }
  failures.push(...checkFamilyPackageNames(repositoryRoot, 'dsh', DSH_FAMILY_PATTERNS))
  failures.push(...checkFamilyPackageNames(repositoryRoot, 'vendor', VENDOR_FAMILY_PATTERNS))
  failures.push(...checkFamilyPackageNames(repositoryRoot, 'landlock', LANDLOCK_FAMILY_PATTERNS))
  if (failures.length > 0) {
    throw new Error(`rescope-to-prettier-ai: ${String(failures.length)} problem(s)\n${failures.join('\n')}`)
  }
}

interface CliManifest {
  name?: string
  bin?: { dsh?: string }
}

function readCliManifest(repositoryRoot: string): CliManifest {
  const path = resolve(repositoryRoot, 'apps/cli/package.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as CliManifest
}

/**
 * Assert every matching family manifest is named `@prettier-ai/*`.
 * @param repositoryRoot - git repository root.
 * @param family - family id for the error message.
 * @param patterns - repository-relative glob patterns.
 * @returns One failure string per misnamed member; empty when the family is absent.
 */
function checkFamilyPackageNames(
  repositoryRoot: string,
  family: string,
  patterns: readonly string[],
): string[] {
  const manifestPaths = globSync([...patterns], { cwd: repositoryRoot }).sort()
  const failures: string[] = []
  for (const manifestPath of manifestPaths) {
    const normalized = manifestPath.replaceAll('\\', '/')
    const path = resolve(repositoryRoot, normalized)
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      failures.push(`postcondition: ${family} member ${normalized} is not a JSON object`)
      continue
    }
    const name = (parsed as { name?: unknown }).name
    if (typeof name !== 'string' || !name.startsWith('@prettier-ai/')) {
      failures.push(
        `postcondition: ${family} member ${normalized} is named ${JSON.stringify(name)}, expected "@prettier-ai/*"`,
      )
    }
  }
  return failures
}

function trackedFiles(repositoryRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

function main(): void {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const check = args.includes('--check')
  const applied = args.includes('--applied')
  if (apply && check) {
    throw new Error('rescope-to-prettier-ai: use only one of --apply or --check')
  }
  if (applied && !check) {
    throw new Error('rescope-to-prettier-ai: --applied is only valid with --check')
  }
  if (check) {
    if (applied) {
      checkAppliedRescope(root)
      console.log('rescope-to-prettier-ai: applied post-state verified — apply is a no-op, CLI is @prettier-ai/dsh.')
    } else {
      checkRescope(root)
      console.log('rescope-to-prettier-ai: overlay verified — mapping is present, sample rewrite is defined.')
    }
    return
  }
  const mode = apply ? 'apply' : 'dry'
  const changed = rescopeTree(root, { apply })
  console.log(`rescope-to-prettier-ai: ${mode} over pack-only paths, ${String(changed.length)} file(s) ${apply ? 'written' : 'would change'}`)
  for (const change of changed) console.log(`  ${change.file}`)
  if (!apply && changed.length > 0) {
    console.log('rescope-to-prettier-ai: re-run with --apply to write.')
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
