# dsh-publisher

English | [中文](./README.zh.md)

Standalone publisher that republishes official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) releases onto the [`@prettier-ai`](https://www.npmjs.com/org/prettier-ai) npm scope. The entry package is `@prettier-ai/dsh`; every workspace package it depends on is published as `@prettier-ai/*`. Versions mirror the official release exactly.

## What this repository is

- A poller: a scheduled workflow reads the official repository's latest GitHub Release and decides whether that version still needs a `@prettier-ai` publication.
- A republisher: when a version is missing, the workflow fetches the official tag into the runner workspace, rewrites the packable package names from `@deepseek-ai/*` to `@prettier-ai/*` (a pack-only rewrite — no product renaming), then packs and publishes from that checkout.
- Overlay scripts plus their unit tests: `scripts/probe-upstream-release.ts` (the decision), `scripts/rescope-to-prettier-ai.ts` (the rewrite), `scripts/inject-deepseek-ai-compat.ts` (host-side `@deepseek-ai/*` compatibility on the packed CLI), `scripts/publish-cli-tarball.ts` (integrity-safe publish of that CLI tarball only), and `scripts/publish-dshp.ts` (thin `@prettier-ai/dshp` wrapper with a `dshp` bin).

## What this repository is not

- Not a fork or mirror of the Harness source tree. No Harness sources are committed here, and the sync workflow never pushes rescoped sources back. A `git clone` of this repository stays small.
- Not a place where Harness development happens. Bugs in the Harness itself belong upstream.
- Not a rebranding. Published tarballs keep the upstream `DeepSeek Harness` product naming, documentation, and MIT license text (including the DeepSeek copyright); only npm package names change scope.

## How polling works

`.github/workflows/sync-upstream-release.yml` runs on a `*/5 * * * *` (UTC) schedule and on manual dispatch. GitHub cron is best-effort: runs may drift by minutes or be dropped under load; the next run catches up.

The cheap `decide` job sparse-checkouts only `scripts/probe-upstream-release.ts` and runs it with Node 24 type stripping — no package installation. The probe:

1. Resolves the upstream tag. With no operator tag it tries `GET /repos/deepseek-ai/deepseek-harness/releases/latest`. If that 404s or there is no non-prerelease latest, it falls back to the newest non-draft GitHub Release from `GET /releases?per_page=1` (this includes prereleases). Drafts are skipped. A dispatch `--tag` still names a specific tag, including prereleases. If upstream has no releases at all, the probe skips.
2. Reads `apps/cli/package.json` at that tag to learn the npm version (falling back to the tag suffix if the file is unavailable).
3. Decides one of:
   - `skip` — `@prettier-ai/dsh@<version>` already exists on the npm registry. The heavy job does not run.
   - `publish-only` — this repository's tracking tag `prettier-ai/<version>` exists but npm lacks the version (for example a previous run packed but could not publish). The heavy job runs again end to end; publishing is idempotent per package.
   - `sync` — the version is new. The heavy job runs and pushes the tracking tag afterwards.

The heavy `sync` job fetches the official tag (shallow clone), copies the overlay scripts onto that checkout, runs `--apply` and `--check --applied` there, installs the rescoped workspace, builds, packs the `vendor` family then the `dsh` family, injects host-side `@deepseek-ai/*` compatibility into the packed CLI tarball so existing DSH plugins keep resolving, uploads the tarballs as workflow artifacts, and publishes.

## What gets published

- `@prettier-ai/dsh` — the CLI, with the upstream `dsh` bin. Packed tarballs include a host-side `@deepseek-ai/*` compatibility layer (runtime module hook plus install-time npm aliases) so existing DSH plugins keep working.
- `@prettier-ai/dshp` — thin wrapper that installs a `dshp` command and runs the same CLI as `@prettier-ai/dsh`. Install `@prettier-ai/dshp` for a `dshp` command; `@prettier-ai/dsh` still ships `dsh`.
- `@prettier-ai/*` — the workspace packages of the official release (core, vendor, and landlock families), each at the upstream version.

The rescope rewrites package manifests, shipped source specifiers, the lockfile, release scripts, and pack-related CI. It deliberately leaves Markdown prose, GitHub URLs, product titles, `description` fields, and the upstream `LICENSE` untouched, so tarballs ship the original MIT text with the DeepSeek copyright.

## Operating

### Required secret

`NPM_TOKEN` — an npm token with publish access to the `prettier-ai` org. Add it under Settings → Secrets and variables → Actions. Without it the workflow still rescopes, packs, and uploads tarball artifacts, then skips `npm publish` with a clear log line.

### Manual dispatch

Run the `Sync upstream release` workflow from the Actions tab (or `gh workflow run`). The optional `tag` input names an upstream git tag directly. Leave it empty to use the same latest-then-newest-non-draft selection as the schedule.

### Pack CLI / Publish CLI

`.github/workflows/publish-cli.yml` is dispatch-only (no schedule). It rescopes the same official tag, injects `@deepseek-ai/*` compatibility, packs **only** `@prettier-ai/dsh`, packs `@prettier-ai/dshp` from this repository, uploads those tarballs, and publishes them when `NPM_TOKEN` is set. It does not pack or publish the vendor/dsh families. Use it when those workspace packages of that version are already on the registry and only the CLI (and `dshp` wrapper) need to ship. Versions still mirror the official release: this workflow does not invent a publisher-side suffix. If `@prettier-ai/dsh@<version>` is already on npm with different contents, CLI publish fails — wait for a new official tag, and inspect the tarball on the run's artifacts. `@prettier-ai/dshp` can still ship in that run without overwriting `@prettier-ai/dsh`.

### Tracking refs

A successful `sync` run pushes a lightweight tag `prettier-ai/<version>` to this repository. The tag marks the version as processed so scheduled runs return to the cheap skip path; it points at this repository's commit, never at upstream sources.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
```

Unit tests are network-free: the probe's GitHub, npm, and git readers are injected, and the rescope tests operate on temporary fixture trees.

## License

This repository's own files are MIT-licensed (© 2026 prettier-ai / aaravarr); see [LICENSE](./LICENSE). Published tarballs are built from the official DeepSeek Harness tree and retain its MIT license and DeepSeek copyright.
