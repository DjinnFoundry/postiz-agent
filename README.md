# postiz-agent

A CLI for preparing and publishing product posts and AudioKids stories. X, TikTok and Instagram use the Postiz API; YouTube uses a separately configured YouTubeCLI. The RSS command builds a podcast feed locally.

Start with the [launch and recovery guide](docs/production-readiness.md) before connecting production accounts. See [deployment](deploy/README.md) for Postiz setup and [SKILL.md](SKILL.md) for agent operating instructions.

## Install

Use **Node.js 22+** and **pnpm 10.18.1**. Clone the maintained `mainline` branch:

```sh
git clone --branch mainline https://github.com/DjinnFoundry/postiz-agent.git
cd postiz-agent
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

Examples use `node dist/cli.js`; a global `postiz-agent` installation is not required. Rebuild after changing TypeScript source.

Dependencies depend on the content:

- Text and image previews do not need Whisper or a running Postiz instance.
- Video validation and RSS duration checks need `ffprobe`.
- Audio stories need `ffmpeg`, `ffprobe`, Whisper with word timestamps, and the HyperFrames renderer. The builder invokes the pinned `hyperframes@0.8.30`; first use can download npm/browser dependencies. `pnpm fetch-fonts` populates the optional local font cache.
- Actual uploads need the selected provider, credentials and connected accounts. Follow [deploy/README.md](deploy/README.md) for the bundled self-hosted Postiz stack.

Shared defaults come from the project-root `.env`. Copy `.env.example` only when creating a new configuration; preserve an existing `.env`. Keep API keys, tenant configurations and generated files out of commits.

## Preview a product post

Save this as `tmp/product-update.json` (create `tmp/` if needed):

```json
{
  "id": "product-update-2026-09-06",
  "kind": "text",
  "locale": "en",
  "text": {
    "body": "Our new feature is ready. Explore it at https://example.com."
  }
}
```

```sh
node dist/cli.js copy preview --bundle-file ./tmp/product-update.json --platform x --json
node dist/cli.js publish --bundle-file ./tmp/product-update.json --platforms x --dry-run --json
```

These commands work without publication credentials. `copy preview` returns the proposed caption. `publish --dry-run` and `render` run local preparation without uploading or writing publication decisions. Media previews may create local render files and theme/cache data. Read the returned file URLs instead of assuming a fixed output path.

The default tenant works without a tenant configuration. Add `--tenant <product>` when previewing that product's branding; named tenants must already have a valid configuration.

### ContentBundle inputs

`publish` and `render` accept either `--bundle-file <json>` or an adapter ID with `--id` / `--slug`, never both. The [ContentBundle schema](src/core/content-bundle.ts) is the input contract. Use a stable, unique ID containing ASCII letters, digits and hyphens, starting with a letter or digit (maximum 128 characters).

| `kind` | Required content | Processing |
|---|---|---|
| `text` | `text.body`, `locale` | Caption-only post on X. |
| `image-post` | Text plus `primaryMedia` pointing to an image | Uses the prepared image, without Whisper. Choose a compatible Postiz target such as X or Instagram. |
| `video` | Text plus `primaryMedia` pointing to a video | Validates and uses the prepared video, without Whisper. |
| `audio-story` | Text plus `primaryMedia` pointing to audio | Transcribes, moderates words and renders editorial slide videos. |

Use absolute local paths for `primaryMedia`. Actual account permissions, provider settings and media constraints still apply. Images are not a YouTube upload mode.

Product bundles (`text`, `image-post`, `video`) preserve the supplied message and links; only configured brand CTAs and hashtags are added. Overlong product captions are rejected rather than silently shortened. Audio stories have their own story-oriented copy and editorial theme selection.

Audio slides require a nonempty transcript with word timestamps. `--skip-transcription` and `--allow-no-captions` do not provide a captionless slide mode; repair transcription or supply a prepared `video` bundle.

## Configure a tenant per product

```sh
node dist/cli.js init
node dist/cli.js tenants list --json
```

The wizard creates `tenants/<product>/config.json`. It also asks for an AudioKids directory; product bundles supplied through `--bundle-file` do not use that source. You can maintain the configuration directly instead:

```json
{
  "postiz": {
    "apiUrl": "https://social.example.com/api/public/v1",
    "apiKey": "",
    "integrationIds": {
      "x": "ACCOUNT_ID_FOR_THIS_PRODUCT"
    }
  },
  "brand": {
    "name": "Example Product",
    "defaultHashtags": ["exampleproduct"],
    "ctas": {
      "instagram": [{ "id": "website", "text": "Discover more through the link in our bio." }]
    }
  }
}
```

Replace the example endpoint/account ID and set the API key privately before uploading. Self-hosted Postiz URLs include `/api/public/v1`; Postiz cloud uses `https://api.postiz.com/public/v1`.

```sh
node dist/cli.js integrations --tenant <product> --json
node dist/cli.js doctor --tenant <product> --json
```

Use the integration IDs returned by Postiz to bind each network under `postiz.integrationIds`. Multiple active accounts on one network cause an ambiguity error when no binding is configured. Review `postiz.platformSettings` for the intended provider settings, especially TikTok privacy and commercial-content declarations.

Each named tenant has isolated decisions, caches and logs under `data/<product>/`, and render work under `tmp/<product>/`. `default` uses `data/` and `tmp/` directly. Missing configuration fields can inherit shared `.env` defaults, so specify the intended accounts and credentials for every production product. Missing or invalid named-tenant configuration fails explicitly.

## Publish and inspect the result

After reviewing the content and selecting the account, omit `--dry-run` for a real upload:

```sh
node dist/cli.js publish --tenant <product> --bundle-file ./tmp/product-update.json --platforms x --reason "approved product update" --json
node dist/cli.js decisions --tenant <product> --slug product-update-2026-09-06 --pretty
```

Always choose the target platforms explicitly. A successful Postiz response confirms acceptance by Postiz, not final publication on the social network. Check its queue and the destination account before enabling unattended operation.

Capture stdout and stderr separately. `publish --json` and `render --json` emit one JSON report on stdout; progress goes to stderr. Check the exit status and each `results[]` entry, including `success`, `skipped`, `errorClass` and `remediation`. Exit 0 can include intentional skips. `runId` connects a report to its decisions.

## AudioKids dispatch and scheduling

The only bundled discovery adapter is `audiokids`. It reads:

| Layout | Files |
|---|---|
| v1 | `<outputDir>/<slug>.json` and `<outputDir>/<slug>.mp3` |
| v2 | `<outputDir>/<slug>/story.json` and `<outputDir>/<slug>/<slug>.mp3` (or a single MP3 in that directory) |

Configure `audiokids.outputDir` for the tenant. Invalid metadata or missing/empty audio is skipped with a stderr warning. Files are preserved for repair.

```sh
node dist/cli.js dispatch --tenant <product> --adapter audiokids --platforms x,instagram --dry-run --json
```

For an authorized unattended workflow, use the same command without `--dry-run`, or configure `daemon`. See [scheduler examples](deploy/cron/README.md). `dispatch` selects the oldest eligible AudioKids candidate and sends only its pending, unblocked platforms. It does not discover arbitrary product-bundle files; use `publish --bundle-file` for those.

The dispatch lookback is **30 days**. Older successes can become eligible again while the source remains in the input directory. Preserve or remove input candidates according to the intended republication policy. No work returns an object containing `dispatched: false` and `reason: "nothing pending"`. Spotify is excluded from per-story dispatch.

Long Instagram audio stories are split into parts of at most 170 seconds. Each accepted part is recorded before the next upload, with scheduled dates spaced at least five minutes apart. Retries retain completed parts and resume missing ones.

## YouTube, RSS and inbox

**YouTube:** configure `youtubecli.path` to a project containing its `youtube_cli` executable and optionally set `youtubecli.channelId` for the product's channel. The adapter runs `video register <file>` to obtain a local UUID, then `video upload <uuid>`. Uploads from this project's publisher are currently **unlisted**. Confirm the channel and uploaded video; do not infer public visibility from a successful result.

**RSS:** configure `AUDIOKIDS_OUTPUT_DIR` and `SPOTIFY_RSS_PUBLIC_URL`, then run:

```sh
node dist/cli.js rss --output ./tmp/feed.xml
```

`rss` uses global environment configuration and has no `--tenant` or `--json` option. It writes XML locally. Hosting the feed, audio and covers, and submitting the feed to podcast platforms are separate operations. This command does not upload to R2 or publish an episode through a Spotify API.

**Inbox:** `inbox list` and `inbox reply` currently use mock providers. Their output is synthetic and replies are simulated; they do not manage live social engagement.

## Recovery without duplicate posts

- Manual `publish` skips an already successful `(id, platform)` within 24 hours. Dispatch uses its separate 30-day window. Both consult archived decisions and exclude preview results.
- Retryable failures receive bounded retries. An ambiguous creation/upload outcome produces `needs-human` with `reconcile-post`; automatic retries stop until the remote outcome is checked.
- A tenant publication lock prevents overlapping runs. A stopped process, or a remote success whose decision could not be saved, can leave `decisions.jsonl.publish.lock` beside that tenant's log. Inspect its PID/time, confirm the process has stopped and reconcile remote posts before removing a stale lock.

Inspect first:

```sh
node dist/cli.js decisions --tenant <product> --stuck --json
node dist/cli.js decisions --tenant <product> --slug <id> --pretty
```

Only after confirming that an ambiguous post was not created, reset the affected platform:

```sh
node dist/cli.js decisions --tenant <product> --reset-attempts <id> --platform x
```

Without `--platform`, reset applies to all platforms recorded for that ID. If a post exists remotely, preserve the block until its verified outcome is recorded. Do not use `--force` as automatic recovery: it bypasses duplicate protection and completed-part reuse. Retain decision archives and completed-part records in backups. See the [recovery procedure and current verification status](docs/production-readiness.md).

## Command catalog

Use `node dist/cli.js <command> --help` for exact options and nested command help where applicable.

| Task | Commands |
|---|---|
| Prepare and publish | `copy preview`, `render`, `publish` |
| AudioKids automation | `dispatch`, `daemon` |
| Configure and diagnose | `init`, `tenants list`, `integrations`, `status`, `doctor` |
| History and reports | `decisions`, `decisions archives`, `stats`, `cta-ab` |
| Local maintenance | `decisions rotate`, `logs`, `logs prune`, `cache prune` |
| Visual catalog | `themes list`, `themes describe`, `gallery` |
| Agent tools and schemas | `tools list --json`, `tools describe <name> --json`, `tools docs` |
| Declarative tools | `run-pipeline <spec.json> --json` or `--stream` |
| Separate feed/mock flows | `rss`, `inbox list`, `inbox reply` |

JSON formatting is command-specific. History queries emit NDJSON by default and an array with `decisions --pretty`. `decisions --stuck --json` emits an array. `run-pipeline --stream` emits one object per step plus a summary. Health reports and tool descriptions can be multiline JSON; parse the complete stdout document.

## Development

```sh
pnpm build
pnpm test
```

CI runs installation from the frozen lockfile, compilation and tests on Node 22. Tests cover contracts and local behavior; they do not establish that a production account has authorized or completed an upload.

The renderer uses [editorial.mjs](hyperframes/templates/editorial.mjs) and the [theme catalog](hyperframes/themes/). After changing its output, review the template tests and snapshots; animation changes also need a real local render.

[MIT license](LICENSE).
