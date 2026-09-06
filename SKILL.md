---
name: postiz-agent
description: Operate this project's CLI to preview or publish product ContentBundles and AudioKids stories, build RSS feeds, inspect publication history, and recover failed or ambiguous uploads without duplicates.
---

# Operate postiz-agent

Use the existing CLI from the repository root: `node dist/cli.js`. Run `pnpm build` when source changes need compiling. Installation requires Node 22+; see [README.md](README.md). For deployment/account configuration read [deploy/README.md](deploy/README.md); for launch checks and recovery read [docs/production-readiness.md](docs/production-readiness.md). Read those references when their workflow applies.

## Choose the content and destination

- Product content uses `publish --bundle-file <json>` with `kind: text`, `image-post` or `video`. Use the [ContentBundle schema](src/core/content-bundle.ts) and [README example](README.md#preview-a-product-post). Text-only posts target X; images use compatible Postiz targets, not YouTube. Prepared media bypasses Whisper.
- AudioKids uses `--id <existing-id>` or its alias `--slug`, with the `audiokids` adapter. Discover the actual v1/v2 files in the configured source; do not invent identifiers. `--bundle-file` and adapter IDs are mutually exclusive.
- `audio-story` requires audio and a nonempty word-level transcript for editorial slides. `--skip-transcription` and `--allow-no-captions` cannot create captionless slides. Repair transcription or use a prepared video.
- IDs are stable duplicate-prevention keys: ASCII letters/digits/hyphens, maximum 128 characters, starting alphanumeric. Do not change an ID merely to bypass a failed or uncertain previous attempt.
- X, TikTok and Instagram publish through Postiz. YouTube uses a separately configured `youtube_cli` executable. Spotify uses the separate RSS flow. Provider access and connected accounts must be checked; implementation alone does not establish availability.

## Select the product's accounts

Use the intended `--tenant` and explicit platform list for publishing, dispatch, previews and relevant diagnostics. Named tenants require a valid `tenants/<product>/config.json`; use `init` or maintain that configuration. `default` uses global defaults and does not require a tenant file.

Inspect `integrations --tenant <product> --json` when configuring real Postiz uploads. Bind returned account IDs using `postiz.integrationIds`. An account name or network alone is insufficient when multiple products share an instance. Check `postiz.platformSettings`, particularly privacy and commercial-content declarations. Missing fields can inherit `.env`; verify that this inheritance is intended. Keep credentials out of command transcripts and commits.

Use `youtubecli.path` and optional `youtubecli.channelId` for the selected YouTube account. The adapter registers the file to obtain a local UUID, then uploads that UUID. This publisher requests **unlisted** visibility. A successful upload is not a public release.

## Preview and publish

For a proposed product post:

```sh
node dist/cli.js copy preview --tenant <product> --bundle-file ./tmp/post.json --platform x --json
node dist/cli.js publish --tenant <product> --bundle-file ./tmp/post.json --platforms x --dry-run --json
```

For an AudioKids video preview:

```sh
node dist/cli.js render --tenant <product> --id <existing-id> --platforms instagram --json
```

Previews require no publication credentials and do not upload or record publication decisions. Rendering can write local artifacts and theme/cache state. Inspect the returned file URLs rather than guessing fixed output locations. Check the copy, links, branding, captions and intended account. Product copy is preserved with explicitly configured CTAs/hashtags; an overlong caption should be corrected, not silently truncated.

A preview request does not authorize a real post. When publication is already authorized, proceed within that scope using `publish` without `--dry-run`, the explicit tenant/platforms, and a meaningful `--reason`; do not request the same authorization again.

Capture stdout separately from stderr and check the exit status. Parse all of stdout for `publish --json` / `render --json`, then inspect `results[].success`, `skipped`, `errorClass`, `remediation`, `parts` and `runId`. A success can be a skip or acceptance by Postiz; verify the remote queue/account before describing content as publicly published.

## Dispatch and partial results

`dispatch` discovers only the bundled AudioKids source. It does not scan arbitrary product-bundle files. `daemon` repeatedly runs that discovery/publication workflow and performs real uploads; use it only within an authorized scheduling scope.

Dispatch selects the oldest eligible candidate and attempts only pending, unblocked platforms within a **30-day** history window. Old input can become eligible again after that window. Spotify is excluded. Invalid metadata or unusable audio is skipped with a warning, without deleting the source. Inspect warnings if expected content is missing.

Instagram audio stories longer than the configured single-reel limit are split into parts of at most 170 seconds. Accepted parts are recorded before the next upload; subsequent attempts reuse completed parts. Scheduling spaces accepted dates at least five minutes apart. Preserve `parts[]` and their records when diagnosing a partially completed run.

## Recover without creating duplicates

1. Inspect `decisions --tenant <product> --slug <id> --pretty` and `decisions --tenant <product> --stuck --json`. Use `--run-id` to correlate a particular run. Queries include archived history.
2. `reconcile-post` means the server or YouTube CLI might have completed the upload before losing the response. Do not repeat it on a timer, invent a fresh ID or use `--force`. Check the remote queue/account first.
3. If the post exists, retain the block until its verified outcome is recorded. If absence is confirmed, use `decisions --tenant <product> --reset-attempts <id> --platform <network>`. Omitting `--platform` resets all platforms recorded for that ID.
4. A retained `decisions.jsonl.publish.lock` contains PID/time. Confirm the process stopped and reconcile its remote effects before removing a stale lock. The file lives beside the tenant's decision log, under `data/<product>/` or `data/` for default.

Manual `publish` guards successes from the previous 24 hours; dispatch uses 30 days. `--force` bypasses protection and completed-part reuse, so reserve it for an explicitly intended republication with a recorded reason. Reset markers do not delete successful history. Keep active decisions, archives and completed-part records together in backups.

## Separate flows and discovery

- `rss --output ./tmp/feed.xml` uses global `AUDIOKIDS_OUTPUT_DIR` and `SPOTIFY_RSS_PUBLIC_URL`. It has no `--tenant` or `--json`. Hosting the generated XML/audio/covers and submitting the feed are separate tasks; `rss` does not upload to R2.
- `inbox list` and `inbox reply` use mock providers. Never report their synthetic items or simulated responses as real social engagement.
- Use the [command catalog](README.md#command-catalog), `<command> --help`, `tools list --json`, `tools describe <name> --json` and `tools docs` to discover supported inputs. Do not assume every command accepts `--tenant` or `--json`.
- `decisions` emits NDJSON by default and a JSON array with `--pretty`; `decisions --stuck --json` emits an array. `run-pipeline --stream` emits step objects and a summary. Its `--dry-run` is a hint to the selected tools; inspect their contracts before assuming all side effects are disabled.

## Renderer maintenance

Edit `hyperframes/templates/editorial.mjs` or the theme catalog when changing visuals, rather than generated HTML. The builder pins HyperFrames 0.8.30 and stages isolated workspaces. GSAP exit animations belong on inner content elements, with an explicit final state at the clip boundary. Review changed snapshots and run the editorial tests; verify animation changes with a real local render. `pnpm build` and `pnpm test` validate local code, not external account readiness.
