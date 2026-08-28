/**
 * Decide whether an official DeepSeek Harness release still needs a
 * `@prettier-ai` publication. The sync workflow calls this before fetching
 * upstream so a repeated schedule run exits quickly when npm or this
 * repository's tracking tag already records the version.
 *
 * The scheduled decide job sparse-checkouts only this file and runs it with
 * Node 24 type stripping (`node scripts/probe-upstream-release.ts`); it does
 * not install anything. The skip path must stay fast because the schedule
 * fires every five minutes.
 *
 * Usage: `node scripts/probe-upstream-release.ts [--tag <upstream-tag>] [--github-output]`.
 * Without `--tag` the probe tries `GET /releases/latest` (non-prerelease). If
 * that 404s or there is no non-prerelease latest, it falls back to the newest
 * non-draft GitHub Release from `GET /releases?per_page=1` (includes
 * prereleases). Drafts are skipped. When upstream has published no releases at
 * all, the probe skips instead of failing. An operator `--tag` still names a
 * specific tag, including prereleases.
 *
 * First-publish probes must treat an unpublished `@prettier-ai/dsh` and a
 * missing `prettier-ai/<version>` tracking tag as absent (return false), not
 * as a crash. npm 404 / E404 / 404 Not Found / `npm error code E404` all mean
 * missing. `git ls-remote --exit-code` statuses 1 and 2 mean the tag is
 * absent. Git HTTPS does not accept a Bearer extraheader; a token is sent as
 * Basic `x-access-token` (the same form actions/checkout uses). If that auth
 * still fails, the probe retries without credentials so a public repository
 * can answer "tag missing".
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness'
const ENTRY_PACKAGE = '@prettier-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`
const NEWEST_RELEASE_URL = `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=1`

/** What the workflow should do for one resolved upstream version. */
export type ProbeAction = 'skip' | 'sync' | 'publish-only'

/** Operator input for one probe. */
export interface ProbeRequest {
  /** Operator-supplied upstream tag; empty selects latest, then newest non-draft. */
  readonly tag: string
}

/** Collaborators the probe uses to read GitHub, npm, and this repository's tags. */
export interface ProbeDependencies {
  readonly fetchJson: (url: string) => Promise<unknown>
  readonly npmHasVersion: (name: string, version: string) => boolean
  readonly gitHasTag: (tag: string) => boolean
}

/** Workflow-facing decision for one upstream version. */
export interface ProbeResult {
  readonly action: ProbeAction
  readonly tag: string
  readonly version: string
  readonly reason: string
}

interface GithubRelease {
  readonly tag_name?: unknown
  readonly draft?: unknown
  readonly prerelease?: unknown
}

interface GithubContent {
  readonly encoding?: unknown
  readonly content?: unknown
}

interface GitLsRemoteResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Strip a `dsh-v` / `v` tag prefix to recover the npm version the release tagged.
 * @param tag - upstream git tag name.
 * @returns The version suffix, or the tag unchanged when it has no known prefix.
 */
export function versionFromUpstreamTag(tag: string): string {
  const prefixed = /^(?:dsh-)?v(.+)$/.exec(tag)
  return prefixed?.[1] ?? tag
}

/**
 * True when an HTTP/GitHub error means the resource is missing.
 * @param error - thrown value from `fetchJson` or a similar helper.
 * @returns True for 404 / Not Found, including `failed: 404 Not Found`.
 */
export function isHttpNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('404') || /not found/i.test(message)
}

/**
 * True when `npm view` output means the package or version is unpublished.
 * @param output - combined stdout and stderr from `npm view`.
 * @returns True for npm 404 / E404 / 404 Not Found / `npm error code E404`.
 */
export function npmViewIndicatesMissing(output: string): boolean {
  const text = output.toLowerCase()
  return (
    text.includes('e404') ||
    text.includes('404 not found') ||
    text.includes('npm error code e404') ||
    /\b404\b/.test(text)
  )
}

/**
 * True when `git ls-remote --exit-code` means the named ref is absent.
 * Git uses 2 when `--exit-code` finds no matches; some versions use 1.
 * @param status - process exit status, or null when the process was signaled.
 * @returns True when the remote did not advertise the ref.
 */
export function gitLsRemoteIndicatesMissing(status: number | null): boolean {
  return status === 1 || status === 2
}

/**
 * True when `git ls-remote` failed because GitHub rejected credentials or
 * could not prompt for them (typical of a Bearer extraheader on git HTTPS).
 * @param status - process exit status.
 * @param output - combined stdout and stderr.
 * @returns True when a retry without credentials may still work on a public remote.
 */
export function gitAuthFailed(status: number | null, output: string): boolean {
  if (status === 0 || gitLsRemoteIndicatesMissing(status)) return false
  const text = output.toLowerCase()
  return (
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('authentication failed') ||
    text.includes('invalid credentials') ||
    text.includes('terminal prompts disabled')
  )
}

/**
 * Decide skip / sync / publish-only for one official release.
 * @param request - optional operator tag.
 * @param deps - GitHub / npm / git readers.
 * @returns The workflow action and the version it names.
 */
export async function probeUpstreamRelease(request: ProbeRequest, deps: ProbeDependencies): Promise<ProbeResult> {
  const release = request.tag === ''
    ? await readLatestRelease(deps)
    : await readNamedRelease(request.tag, deps)
  if (release === null) {
    return {
      action: 'skip',
      tag: '',
      version: '',
      reason: 'upstream has no GitHub Release yet',
    }
  }
  const version = await readUpstreamVersion(release.tag, deps)
  if (deps.npmHasVersion(ENTRY_PACKAGE, version)) {
    return {
      action: 'skip',
      tag: release.tag,
      version,
      reason: `${ENTRY_PACKAGE}@${version} is already on the npm registry`,
    }
  }
  const trackingTag = `prettier-ai/${version}`
  if (deps.gitHasTag(trackingTag)) {
    return {
      action: 'publish-only',
      tag: release.tag,
      version,
      reason: `tracking tag ${trackingTag} exists but ${ENTRY_PACKAGE}@${version} is missing from npm`,
    }
  }
  return {
    action: 'sync',
    tag: release.tag,
    version,
    reason: `new official tag ${release.tag} (version ${version})`,
  }
}

async function readLatestRelease(deps: ProbeDependencies): Promise<{ tag: string } | null> {
  const stable = await readStableLatestRelease(deps)
  if (stable !== null) return stable
  return await readNewestNonDraftRelease(deps)
}

async function readStableLatestRelease(deps: ProbeDependencies): Promise<{ tag: string } | null> {
  let payload: unknown
  try {
    payload = await deps.fetchJson(LATEST_RELEASE_URL)
  } catch (error) {
    // 404 means upstream has never published a non-prerelease release.
    if (isHttpNotFound(error)) return null
    throw error
  }
  const release = asRelease(payload, `GET /repos/${UPSTREAM_REPO}/releases/latest`)
  if (release.draft === true || release.prerelease === true) return null
  return { tag: release.tag }
}

async function readNewestNonDraftRelease(deps: ProbeDependencies): Promise<{ tag: string } | null> {
  let payload: unknown
  try {
    payload = await deps.fetchJson(NEWEST_RELEASE_URL)
  } catch (error) {
    if (isHttpNotFound(error)) return null
    throw error
  }
  if (!Array.isArray(payload)) {
    throw new Error(`GET /repos/${UPSTREAM_REPO}/releases?per_page=1 did not return an array`)
  }
  const first = payload[0]
  if (first === undefined) return null
  const release = asRelease(first, `GET /repos/${UPSTREAM_REPO}/releases?per_page=1`)
  if (release.draft === true) return null
  return { tag: release.tag }
}

async function readNamedRelease(tag: string, deps: ProbeDependencies): Promise<{ tag: string }> {
  try {
    const payload = await deps.fetchJson(
      `https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/${encodeURIComponent(tag)}`,
    )
    const release = asRelease(payload, `GET /repos/${UPSTREAM_REPO}/releases/tags/${tag}`)
    return { tag: release.tag }
  } catch (error) {
    if (!isHttpNotFound(error)) throw error
    return { tag }
  }
}

async function readUpstreamVersion(tag: string, deps: ProbeDependencies): Promise<string> {
  const fallback = versionFromUpstreamTag(tag)
  try {
    const payload = await deps.fetchJson(
      `https://api.github.com/repos/${UPSTREAM_REPO}/contents/apps/cli/package.json?ref=${encodeURIComponent(tag)}`,
    )
    const content = asContent(payload)
    const manifest: unknown = JSON.parse(content)
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`upstream apps/cli/package.json at ${tag} is not a JSON object`)
    }
    const version = (manifest as { version?: unknown }).version
    if (typeof version !== 'string' || version === '') {
      throw new Error(`upstream apps/cli/package.json at ${tag} has no version string`)
    }
    return version
  } catch (error) {
    if (isHttpNotFound(error)) return fallback
    throw error
  }
}

function asRelease(payload: unknown, source: string): { tag: string; draft?: unknown; prerelease?: unknown } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${source} did not return an object`)
  }
  const release = payload as GithubRelease
  if (typeof release.tag_name !== 'string' || release.tag_name === '') {
    throw new Error(`${source} omitted tag_name`)
  }
  return { tag: release.tag_name, draft: release.draft, prerelease: release.prerelease }
}

function asContent(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub contents response is not an object')
  }
  const body = payload as GithubContent
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error('GitHub contents response is not base64 content')
  }
  return Buffer.from(body.content.replaceAll('\n', ''), 'base64').toString('utf8')
}

/**
 * `npm view` whether a version exists on the configured registry.
 * @param name - package name.
 * @param version - exact version.
 * @param registry - npm registry URL.
 * @returns True when the registry has that version; false when it is unpublished.
 */
export function npmHasVersion(name: string, version: string, registry = DEFAULT_REGISTRY): boolean {
  const result = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--registry', registry, '--json'],
    { encoding: 'utf8' },
  )
  if (result.status === 0) return true
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (npmViewIndicatesMissing(output)) return false
  throw new Error(`npm view ${name}@${version} failed:\n${output}`)
}

/**
 * `git ls-remote` whether this repository already has a tracking tag.
 * @param tag - `prettier-ai/<version>`.
 * @param remote - publisher git URL (never embed a token in this URL).
 * @param token - optional GitHub token sent as an HTTP extraheader.
 * @returns True when the remote advertises that tag; false when it is absent.
 */
export function gitHasTag(tag: string, remote: string, token = ''): boolean {
  const first = runGitLsRemote(remote, tag, token)
  const firstOutput = `${first.stdout}${first.stderr}`
  if (first.status === 0) return true
  if (gitLsRemoteIndicatesMissing(first.status)) return false
  if (token !== '' && gitAuthFailed(first.status, firstOutput)) {
    const retry = runGitLsRemote(remote, tag, '')
    if (retry.status === 0) return true
    if (gitLsRemoteIndicatesMissing(retry.status)) return false
    throw new Error(`git ls-remote ${remote} ${tag} failed:\n${retry.stdout}${retry.stderr}`)
  }
  throw new Error(`git ls-remote ${remote} ${tag} failed:\n${firstOutput}`)
}

function gitCredentialArgs(token: string): string[] {
  if (token === '') return []
  // Git HTTPS on github.com expects HTTP Basic, not a REST Bearer token.
  // Bearer extraheaders make git prompt for a username and exit 128 in CI.
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`]
}

function runGitLsRemote(remote: string, tag: string, token: string): GitLsRemoteResult {
  const result = spawnSync(
    'git',
    [...gitCredentialArgs(token), 'ls-remote', '--exit-code', remote, `refs/tags/${tag}`],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'prettier-ai-dsh-publisher',
  }
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(`${url} failed: ${String(response.status)} ${response.statusText}`)
  }
  return await response.json() as unknown
}

function publisherRemote(): string {
  const repository = process.env.GITHUB_REPOSITORY
  if (repository !== undefined && repository !== '') return `https://github.com/${repository}.git`
  return 'https://github.com/prettier-ai/dsh-publisher.git'
}

function writeGithubOutput(result: ProbeResult): void {
  const body = [
    `action=${result.action}`,
    `tag=${result.tag}`,
    `version=${result.version}`,
    `reason=${result.reason}`,
    '',
  ].join('\n')
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath !== undefined && outputPath !== '') appendFileSync(outputPath, body)
  console.log(body.trimEnd())
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      'github-output': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const result = await probeUpstreamRelease(
    { tag: values.tag ?? '' },
    {
      fetchJson,
      npmHasVersion: (name, version) => npmHasVersion(name, version),
      gitHasTag: tag => gitHasTag(tag, publisherRemote(), process.env.GITHUB_TOKEN ?? ''),
    },
  )
  if (values['github-output'] === true) writeGithubOutput(result)
  else console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main()
}
