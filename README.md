# postiz-agent

> Autonomous daily publisher for [AudioKids](https://github.com/DjinnFoundry/audiokids) audio stories.
> Turns one MP3 cuento into platform-ready posts for X, TikTok, Instagram, YouTube, and Spotify — with book-page slide videos, word-level karaoke captions, and a decision log an LLM can read back later.

**Agents: read [`SKILL.md`](./SKILL.md) first.** It explains when to use each command, what the flags mean, and what NOT to do.

---

## The gap it fills

[Postiz](https://github.com/gitroomhq/postiz-app) is a great social scheduler but it's content-agnostic — you hand it a finished post and it publishes. AudioKids produces MP3 files. No social platform accepts raw audio. This project is the layer that turns one into the other.

```
AudioKids (MP3 + metadata)          Postiz (X/TikTok/IG adapters)
        │                                   ▲
        └─── postiz-agent ──────────────────┘
              │
              ├─ whisper word-level transcription
              ├─ HyperFrames slide video per aspect ratio
              ├─ YouTubeCLI delegation (for YouTube)
              └─ RSS feed (for Spotify/Apple)
```

## What gets published

| Platform | Format | Render spec |
|---|---|---|
| **X** | Video | 1:1 · 1080×1080 · up to 4h (Premium) |
| **TikTok** | Video | 9:16 · 1080×1920 · up to 10min |
| **Instagram Reels** | Video | 9:16 · 1080×1920 · up to 3min (multi-part for longer cuentos) |
| **YouTube** | Video | 16:9 · 1920×1080 · no limit |
| **Spotify / Apple / Amazon** | Audio (RSS) | MP3 feed polled hourly |

Each video is a slide-based composition: book-page pacing (15-25 words per slide), current-word highlight with weight + scale shift, narrator's voice as the audio track. Visual identity comes from a **theme engine** with 12 editorial treatments (magazine-style hero, midnight, rose-stamp, academic-dropcap, medieval-manuscript with gilded drop cap, mythic-scroll, epic-cinematic, terminal-CRT, storybook-pop, crayon-doodle, bubble-pastel, big-stat) across 4 families (editorial, infantil, épica, tech). Each bundle resolves to one treatment deterministically via priority: persisted decision > explicit hint > keyword match > mood candidate > fallback. See `TREATMENTS.md` for the full catalog.

Instagram Reels cap at 3 minutes, so cuentos longer than that are **automatically split** into N ≤170s parts, each rendered with a treatment-styled part ribbon (`CAPÍTULO I de III` for medieval, `[PART 01/03]` for terminal, etc.) and scheduled 5 minutes apart so they land in order on your feed.

## Example

A one-minute story becomes four ready-to-upload MP4s with a single command:

```
$ postiz-agent render --slug dragon-marcos --platforms x,tiktok,instagram,youtube

story: "El dragón curioso" (145 words, 1min)
transcribing audio...
  118 words → tmp/dragon-marcos/dragon-marcos.json
→ x          dragon-marcos-x.mp4          1080×1080 · 40s · 2.3MB
→ tiktok     dragon-marcos-tiktok.mp4     1080×1920 · 40s · 2.6MB
→ instagram  dragon-marcos-instagram.mp4  1080×1920 · 40s · 2.6MB
→ youtube    dragon-marcos-youtube.mp4    1920×1080 · 40s · 2.6MB
```

Swap `render` for `publish` and the same videos get uploaded through Postiz and YouTubeCLI.

## Install

Prerequisites: Node 20+, ffmpeg, whisper (`pip install openai-whisper`), Docker (for the bundled self-hosted Postiz).

```bash
git clone https://github.com/DjinnFoundry/postiz-agent.git
cd postiz-agent
pnpm install

cp .env.example .env
# edit POSTIZ_API_URL, POSTIZ_API_KEY, AUDIOKIDS_OUTPUT_DIR
# (optional) set ALERT_WEBHOOK_URL to get a POST when a platform publish fails

# Optional: install HyperFrames skills for Claude Code / Cursor
npx skills add heygen-com/hyperframes
```

Then deploy Postiz self-hosted and connect each platform's OAuth:

```bash
cd deploy
cp .env.example .env
# add X_API_KEY, X_API_SECRET, TIKTOK_CLIENT_KEY, INSTAGRAM_APP_ID, ...
docker compose up -d
# open http://localhost:5000 and connect X, TikTok, Instagram
# copy the Postiz public API key back to the project's root .env
```

Verify:

```
$ postiz-agent status
✓ ffmpeg installed
✓ ffprobe installed
✓ whisper installed
✓ npx installed
✓ AudioKids output dir   /path/to/audiokids/output
✓ Postiz API reachable   http://localhost:5000/public/v1
✓ POSTIZ_API_KEY set     present
✓ YouTubeCLI project path /path/to/youtubecli
```

## Commands

Full reference is in the CLI itself (`postiz-agent <cmd> --help`). Short version:

**Pipeline (what agents run day-to-day)**

| Command | What it does |
|---|---|
| `dispatch` | Autonomously pick the next story not yet published and run it. Cron-safe. Skips slugs stuck with 3+ permanent failures in 72h (transient backoff ladder 1h/4h/16h). |
| `publish --slug <s> --platforms <list>` | Full pipeline: preflight → transcribe → moderate → render → upload |
| `render --slug <s> --platforms <list>` | Build MP4s only, no upload |
| `rss --output <path>` | Rebuild the Spotify / Apple RSS feed |
| `run-pipeline <spec.json> [--id <slug>] [--stream]` | Run a declarative pipeline of tools. `--stream` emits NDJSON per step |

**Observability and operations**

| Command | What it does |
|---|---|
| `status [--json]` | Lightweight health snapshot (deps + counts: tools, treatments, decisions, uploads, stuck slugs, 7d success rate) |
| `doctor [--json]` | Deep diagnostic with remediation hints per blocking issue. Exit 1 on any `permanent` / `needs-config` / `needs-human` |
| `stats [--days N] [--platform X] [--json]` | Rollup of the decision log: totals, per-platform success rate, top remediations, CTA variant distribution |
| `cta-ab [--days N] [--platform X] [--ingest file.jsonl] [--json]` | Per-variant success rate and sample posts. `--ingest` merges engagement data (postId, views, likes, comments) |
| `decisions [--slug s] [--platform p] [--run-id uuid] [--stuck] [--pretty]` | Query the JSONL publish history |
| `decisions rotate [--force] [--json]` · `decisions archives [--json]` | Rotate the active log and list archived files |
| `decisions --reset-attempts <slug>` | Clear the stuck counter after fixing the underlying cause |
| `logs [--slug s] [--platform p] [--tail]` · `logs prune [--older-than-days N] [--dry-run]` | Inspect captured HyperFrames stderr and prune old logs (default 30 days) |
| `cache prune [--dry-run] [--json]` | Prune stale upload-cache entries (7d TTL) |

**Theming and content**

| Command | What it does |
|---|---|
| `themes list [--json]` | List the 12 editorial treatments |
| `themes describe <id> [--json]` | Resolve a treatment with its palette + font pairing + layout hints + examples |
| `themes check-decisions [--json] [--fix]` | List theme decisions stale due to catalog version bump or unknown treatment id |
| `gallery --id <slug> [--output path] [--include-treatments a,b]` | Render the same bundle across all treatments into one HTML page for visual QA |
| `copy preview [--id <slug>] [--platform X] [--json]` | Print the caption that would be posted, with CTA variant and teaser surfaced |

**Tool introspection (for external agents)**

| Command | What it does |
|---|---|
| `tools list [--json]` | List registered tools with their JSON schemas |
| `tools describe <name> [--json]` | Full descriptor: input/output schemas, examples, typical next steps |
| `tools docs [<name>]` | Human guide to all tools or one specific tool |
| `tools call <name> --id <slug> [--input file.json]` | Invoke a single tool aisladamente (agent-level) |

**Misc**

| Command | What it does |
|---|---|
| `integrations [--json]` | List connected Postiz accounts |

Every command supports `--help` and `--json` where applicable.

### Reliability features (enabled by default on `publish` / `dispatch`)

- **Preflight checks per platform.** Refuses early when audio is too long, bitrate too low (< 64 kbps), cover missing, or the target is RSS-only. Saves 2-3 minutes of wasted render.
- **Error taxonomy with remediation hints.** Every failure is classified (`transient | permanent | needs-config | needs-human | unknown`) with a machine-readable `action` and a human hint. Threaded through the decision log so `doctor` can suggest remediation.
- **Retry with exponential backoff.** Transient errors retry 3 times (~2s base, jittered). 4xx does not retry.
- **Dispatch stuck-slug guard.** A slug with 3+ permanent failures in 72h is skipped until manually reset with `decisions --reset-attempts`. Transient failures follow a 1h/4h/16h backoff ladder.
- **24h idempotency guard.** Skips any `(slug, platform)` that already has a successful decision in the last 24 hours. Bypass with `--force`.
- **Postiz rate limit.** 10 req/s token bucket per PostizClient instance, with in-flight dedupe and 30s cache for `listIntegrations` across parallel publishes.
- **Upload dedup + streaming.** SHA256 cache with 7d TTL skips re-uploading the same MP4 on retry; `openAsBlob` streams large files so a 30 MB MP4 no longer pins 30 MB of heap.
- **Atomic render output.** Videos are written to `.tmp`, size-checked (>100KB) and duration-probed (>0s) before the final rename. Captured HyperFrames stderr goes to `data/render-logs/` for post-mortem.
- **Webhook alerts.** Set `ALERT_WEBHOOK_URL`. After retries exhaust, the agent fires a 5s-timeout POST with `{slug, platform, error, attempts, timestamp}`. Fire-and-forget.
- **Caption moderation (Spanish, ~120 terms + conjugations).** Words matching the blocklist are masked before render. Disable for debugging with `--no-moderation`.
- **Whisper confidence flag.** `transcribe` can be invoked with a `minConfidence` threshold; low-confidence words are counted and reported as warnings (guards against silent hallucinations that the moderation layer would mask).
- **Recipient consent.** `anonymous` scrubs the name from title + teaser across platforms; `first-name-only` drops surnames only; `public` leaves them as-is.
- **`runId` correlation.** Every `publish` mints a UUID v4 that is attached to every decision log entry it produces (including IG multi-part children). Query with `decisions --run-id <uuid>`.
- **Instagram multi-part split.** Cuentos > 3 min are auto-chunked into N ≤170s parts; treatment-styled ribbons (`CAPÍTULO I de III`, `[PART 01/03]`, ...), scheduled 5 min apart. Every part shares the same CTA variant (brand invariant).

### Scheduling

Ready-to-edit configs ship in `deploy/cron/`:

- `crontab.example` (Linux/macOS)
- `com.djinnfoundry.postiz-agent.plist` (macOS launchd)
- `README.md` (systemd timer for Linux servers)

The typical setup:

```bash
# Linux/macOS crontab, daily at 08:00
0 8 * * * cd /path/to/postiz-agent && pnpm dev dispatch --platforms x,tiktok,instagram,youtube --json >> data/cron.log 2>&1
```

`dispatch` exits 0 with `{"dispatched": false, "reason": "nothing pending"}` when there is nothing to publish, so you can run it more often than your content cadence without churn.

## Architecture

Five layers so any agent / pipeline (not just AudioKids) can drive the toolkit:

```
L4 · entry    CLI · external agent
L3 · pipes    pipelines (JSON specs) · orchestrator
L2 · adapters audiokids → ContentBundle
L1 · tools    transcribe · moderate-captions · render-slide-video · resolve-theme · choose-theme
L0 · core     errors taxonomy · retry · decision log · idempotency · preflight · rate limit · upload cache
```

```
src/
├── cli.ts                       # commander entry, delegates to cli/* helpers
├── orchestrator.ts              # bundle → preflight → transcribe → moderate → publish
├── dispatch.ts                  # next-unpublished selection + stuck-slug backoff
├── idempotency.ts · config.ts · types.ts
│
├── core/
│   ├── content-bundle.ts        # neutral contract every tool consumes
│   ├── tool.ts · tool-registry.ts · pipeline.ts · zod-json-schema.ts
│   ├── errors.ts                # ClassifiedError taxonomy + remediation hints
│   └── preflight.ts             # per-platform capability + bitrate + duration
│
├── adapters/                    # pipeline → ContentBundle
│   ├── audiokids.ts
│   └── cover-placeholder.ts     # SVG fallback cover
│
├── tools/                       # composable units
│   ├── transcribe.ts            # whisper + optional minConfidence + optional trimSilence
│   ├── moderate-captions.ts · render-slide-video.ts · resolve-theme.ts
│
├── theme/                       # catalog + resolver + decision store (versioned)
│   ├── catalog.ts · resolver.ts · types.ts
│
├── copy/                        # caption building + CTA rotation + hashtags (multi-locale)
│   ├── caption-builder.ts · ctas.{json,ts} · hashtags.{json,ts}
│
├── platforms/
│   ├── postiz.ts                # rate-limit (10 req/s) + integration cache + SHA256 upload dedup + streaming
│   ├── {x,tiktok,instagram,youtube,spotify}-publisher.ts
│   ├── postiz-video-publisher.ts · instagram-split.ts · spotify-rss.ts · registry.ts · youtube.ts
│
├── media/
│   ├── subtitles.ts · whisper-json.ts · caption-moderation.ts · spanish-blocklist.json
│   ├── slide-video.ts           # staged workspace, atomic output, render-log persistence
│   ├── render-output.ts         # finalize + persistStderr + size + duration verify
│   └── silence.ts               # ffmpeg silencedetect wrapper
│
├── decisions/log.ts             # JSONL append-only, atomic rotation at 10 MiB, runId
├── cli/                         # per-subcommand helpers (doctor, stats, themes, gallery, cta-ab, housekeeping, status, tools-docs, decisions-window)
└── lib/{process,ffprobe,retry,alerts,slug,color,token-bucket,upload-cache,safe-path}.ts

hyperframes/
├── templates/
│   ├── common.mjs               # buildPages, part-ribbon, end-card, SVG ornaments, font resolver
│   └── editorial.mjs            # the single parametric template driven by a resolved theme
├── themes/
│   ├── palettes.json            # 29 palettes, WCAG-AA verified
│   ├── fonts.json               # 10 pairings, local caching via scripts/fetch-fonts.ts
│   └── treatments.json          # 12 treatments, keywordHints, moodCandidates, fallback
└── assets/fonts/                # (gitignored) local font cache; run `pnpm fetch-fonts`

deploy/
├── docker-compose.yml           # self-hosted Postiz + Postgres + Redis
├── cron/                        # crontab + launchd + systemd timer examples
└── README.md
```

### Why this shape

- **ContentBundle as the neutral contract.** AudioKids is the first consumer, not the core. Any pipeline that emits a `ContentBundle` drives the same tools.
- **Tools are introspectable by agents.** Each tool publishes `inputSchema`, `outputSchema`, `examples`, and `composes` via `tools list --json`. An external agent discovers and chains them via `run-pipeline`.
- **Themes resolve deterministically and are reproducible.** The resolver hashes `bundle.id` to pick among candidates, persists the decision with the current `catalogVersion`, and re-resolves when the catalog bumps. Agents override via `choose-theme`.
- **One publisher per file, uniform base class.** Adding a platform is: new file + one method + one line in `registry.ts`.
- **Transcription runs once, cached on disk.** All variants share the same word timestamps.
- **YouTube delegates to YouTubeCLI.** It already owns analytics and its own decision log; we shell out.
- **Spotify is RSS, not API.** No per-episode endpoint for indies. We host a feed; platforms poll it.
- **Video templates are plain HTML + GSAP, not React.** ~40% smaller output than Remotion at equivalent quality. An agent can write a new treatment in HTML + CSS.
- **Decision log is JSONL + runId.** Append-only, greppable, rotates at 10 MiB. Every orchestrator run mints a UUID threaded into every decision it produces.

## Costs

For 1 story/day across all 5 platforms:

| Platform | Cost | Setup |
|---|---|---|
| X | ~$2–$10/mo (pay-per-use, or $8/mo Premium for 4h video limit) | developer.x.com |
| TikTok | free | developers.tiktok.com (requires production review) |
| Instagram | free | Meta App + Business/Creator IG account |
| YouTube | free (quota) | Google Cloud project |
| Spotify + Apple + Amazon | free | RSS submission only |

**Total: under ~$10/month** of API costs. Everything else is open source.

## Status

Shipping (751 unit + integration tests):
- End-to-end publish pipeline with error taxonomy and remediation hints
- `dispatch` with stuck-slug detection + 1h/4h/16h transient backoff ladder
- Preflight: duration cap, bitrate (≥64 kbps), cover existence, platform capability
- Retry with exponential backoff, 24h idempotency guard, webhook alerts
- Postiz rate-limit (10 req/s), integration cache, SHA256 upload dedup, streaming uploads (`openAsBlob`)
- Atomic MP4 finalisation with size + duration verification; captured stderr in `data/render-logs/`
- Caption moderation against a Spanish blocklist (~120 terms with conjugations)
- Whisper with optional per-word `minConfidence` flagging + optional `trimSilence`
- Recipient consent (`public`, `first-name-only`, `anonymous`) with Unicode-boundary redaction
- Theme engine: 12 treatments × 29 WCAG-AA palettes × 10 font pairings; deterministic resolver with persisted decisions + `catalogVersion` freshness
- Multi-locale hashtags and CTAs (es + en, fallback to es); deterministic CTA rotation per bundle
- Instagram multi-part split with treatment-styled ribbons, stable CTA across parts
- Spotify RSS generator
- Tool registry with examples + composes, introspectable via `tools list/describe/docs`
- Declarative pipelines with NDJSON streaming (`run-pipeline --stream`)
- `doctor`, `stats`, `cta-ab` (with engagement ingest), `themes`, `gallery`, `logs`, `cache`, `copy preview` subcommands
- Decision log JSONL with rotation at 10 MiB + `runId` correlation + `--reset-attempts`
- Path traversal guard on `--bundle-file`
- Self-hosted Postiz docker-compose

Intentionally not shipping yet:
- Additional mood templates — `fantasia` covers all moods via fallback. Authoring the other six is deferred by product decision.
- Engagement ingestion from YouTubeCLI + Postiz back into the decision log (future feedback loop).

## License

Internal to the DjinnFoundry / AudioKids toolkit.

---

## For agents

See [`SKILL.md`](./SKILL.md) for workflow heuristics, platform quirks, and things to avoid. It's the contract this repo publishes for LLM agents to consume.
