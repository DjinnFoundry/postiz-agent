---
name: postiz-agent
description: Daily autonomous publishing of MP3-first content packages to X, TikTok, Instagram, YouTube, and Spotify (RSS). Use when asked to publish content, preview what an audio item will look like on social, build podcast RSS feeds, check publishing history, or add new mood-themed visual templates.
---

# postiz-agent

This is your operating manual. Follow it before inventing a new workflow — the tool already has the primitive you need in most cases.

## What this tool does

Given a content slug, one invocation:

1. Reads the audio (MP3), metadata (JSON), and cover art from the configured content output directory.
2. Runs whisper once to get word-level timestamps. Caches the result.
3. For each target platform (X, TikTok, Instagram, YouTube), renders a slide-based MP4 video: book-page pacing, narrator voice, per-word karaoke highlighting in the story's mood palette.
4. Uploads the video through the right adapter:
   - X / TikTok / Instagram → Postiz public API (self-hosted)
   - YouTube → YouTubeCLI (delegates, preserves YouTubeCLI's decision log + analytics)
   - Spotify → no-op; the RSS feed (rebuilt separately with `rss`) is the channel
5. Appends every attempt to `data/decisions.jsonl` with the stated reason and the platform result.

## Before any action — run status

Whenever you start a session with this tool, first:

```
postiz-agent status
```

This checks: ffmpeg, whisper, npx, Postiz API reachability, POSTIZ_API_KEY present, content output dir exists, YouTubeCLI path exists. If required checks fail, fix them before proceeding — publishing will fail in a confusing way otherwise.

## The daily publishing workflow

### Automated / scheduled (preferred)

```
postiz-agent dispatch --platforms x,tiktok,instagram,youtube
```

`dispatch` is the autonomous entry point. It scans `CONTENT_OUTPUT_DIR`, consults
the decision log, and picks the oldest item not yet fully published to the target
platforms in the last 30 days. Exits 0 with `{"dispatched": false, "reason":
"nothing pending"}` when there is nothing to do — safe to run every N hours from
cron/systemd. Pair with `--json` for clean, parseable output.

### Interactive (preview before shipping)

```
1. postiz-agent status                                   # sanity check
2. postiz-agent render --slug <slug> --platforms tiktok  # preview one platform
3. (inspect tmp/<slug>/<slug>-tiktok.mp4 manually)
4. postiz-agent publish --slug <slug>                    # full publish, all platforms
5. postiz-agent decisions --slug <slug>                  # verify what happened
```

Do **not** skip the render step unless the user has explicitly told you to run autonomously. A broken mood template or a whisper mis-alignment wastes API calls and floods the user's feed with bad content.

The orchestrator also guards against whisper failures: if transcription crashes, the run aborts before render with exit 1 (no silent no-caption videos get posted). Pass `--allow-no-captions` to override when you truly want the video out regardless.

## Commands — quick reference

| Command | Purpose | Exit codes |
|---------|---------|------------|
| `dispatch` | Auto-pick the next unpublished item and publish it (cron entry point) | 0 ok or nothing pending, 1 on publish failure |
| `status` | Environment health check | 0 ok, 1 if required deps missing |
| `integrations` | List connected Postiz OAuth accounts | 0 ok, 1 if Postiz unreachable |
| `render --slug X --platforms ...` | Build MP4s, no upload | 0 ok, 1 on render failure |
| `publish --slug X --platforms ...` | Full pipeline: render + upload | 0 all succeeded, 1 any failed |
| `rss --output feed.xml` | Rebuild Spotify podcast feed | always 0 unless write fails |
| `decisions --slug X --platform P` | Query publish history | always 0 |

Every command accepts `--help` with examples. Commands that emit JSON also accept `--json` for agent-friendly output (one line, no ANSI).

## Flag conventions

- `--slug` is the basename of the source output files (e.g. `launch-recap` for `launch-recap.mp3` + `launch-recap.json`). Never fabricate one.
- `--platforms` is comma-separated: `x,tiktok,instagram,youtube,spotify`. `spotify` is a valid target but produces no per-story output — it relies on the RSS feed.
- `--dry-run` (publish only) renders videos but skips uploads. Equivalent to running `render` except the decision log records intent.
- `--skip-transcription` turns off whisper. Videos will have no captions. Only use if whisper is broken and you want to still get a video out, or if the audio is non-speech.
- `--allow-no-captions` (publish/render) lets the pipeline continue when whisper CRASHES (as opposed to `--skip-transcription` which is a deliberate opt-out). Without this flag, a whisper crash aborts before render with exit 1 — you do NOT want silent no-caption videos on the feed.
- `--reason` (publish only) is a free-text string recorded in the decision log. Use this when the action is something other than the default daily schedule — e.g. `--reason "re-publish after fixing mood palette"`.
- `--json` on `status`, `publish`, `render`, `decisions`, `integrations` switches to machine-readable output.

## Platform-specific behavior you need to know

### X / Twitter
- Default 2-minute hard limit. Audio over 2min requires X Premium on the account (4h limit).
- Needs Postiz connected with `X_API_KEY` + `X_API_SECRET` in `deploy/.env`. Uses OAuth 1.0a; tokens do not auto-refresh.
- If publish returns `403`, it's usually a transitional bug after a pay-per-use migration. Check `integrations` and retry once.

### TikTok
- Up to 10 minutes per post.
- The Postiz app requires production review on TikTok's side (5-10 days). Do not assume it's set up without running `integrations` first.

### Instagram
- Reels cap at 3 minutes. For longer audio, the `InstagramPublisher` splits automatically into N ≤170s windows (aligned to `beats[]` when possible, else on word boundaries). Each part renders its own MP4 with a `PARTE i/N` ribbon in the intro card and is scheduled 5 minutes apart via Postiz `scheduledDate` so they land in order. The `PublishResult` for a multi-part publish has `parts[]` populated; each part gets its own decision log entry (`publish.instagram.part1`, `publish.instagram.part2`, ...).
- Requires a Business or Creator account linked to a Facebook Page.

### YouTube
- No duration limit. We render a 16:9 variant and hand it to YouTubeCLI.
- YouTubeCLI has its own decision log, analytics, and competitive-research tools. Prefer those for YouTube-specific questions. Don't try to re-implement them here.

### Spotify (and Apple Podcasts, Amazon Music)
- There is no per-episode publishing API for indie podcasters. We host an RSS feed; the platforms poll it.
- After each new story, regenerate: `postiz-agent rss --output ./tmp/feed.xml`, then upload `feed.xml` + the MP3s to the public R2 bucket. Submit the feed URL once at podcasters.spotify.com; updates are automatic.

## Adding a new mood template

Content items have a `mood` field that maps to `hyperframes/templates/<mood>.mjs`. Currently only `fantasia` has a template; other moods fall back to `fantasia` automatically with a warning surfaced in `PublishResult.warnings`.

To add a new mood:

1. Copy `hyperframes/templates/fantasia.mjs` → `hyperframes/templates/<mood>.mjs`.
2. Edit the palette + typography + layout to match the mood. The template is pure HTML + CSS + GSAP — no build step.
3. Run a quick validation:
   ```
   cd hyperframes
   echo '{"title":"Test","byline":"Test · 6 años","mood":"<mood>","audioSrc":"assets/narration.mp3","words":[{"text":"Hola","start":0,"end":0.4}],"width":1080,"height":1920}' | node templates/<mood>.mjs
   npx hyperframes lint
   npx hyperframes preview
   ```
4. Open the preview URL and iterate. When it looks right, commit.

`hyperframes/` ships with the `hyperframes` skill from HeyGen — invoke `/hyperframes` in Claude Code sessions that touch this directory for patterns around `data-*` attribute semantics, shader rules, and timeline registration.

## Reliability features you should know about

These are wired into `publish` and `dispatch` by default. You only need to think about them when the defaults don't match the user's intent.

### Retry with exponential backoff
Every platform publish is wrapped in `retry()` (3 attempts, ~2s base, jittered). HTTP 5xx and network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) are retryable; 4xx (auth/validation) is not. A transient 500 from Postiz does not lose the post.

### 24-hour idempotency guard
Before each real publish (not `--dry-run`), the orchestrator queries the decision log for a successful entry on the same `(slug, platform)` in the last 24 hours. If one exists, that platform is **skipped** with `{success: true, skipped: true, reason: "already published today"}`. To override, pass `--force`.

### Webhook alerts
If `ALERT_WEBHOOK_URL` is set in `.env`, the agent fires a 5-second-timeout POST with `{slug, platform, error, attempts, timestamp}` after a publish exhausts its retries. The webhook call is fire-and-forget; webhook failures never block the publish.

### Caption moderation
After whisper transcription, every word passes through `moderateWords()` against `src/media/spanish-blocklist.json`. Blocklisted tokens are replaced with `***` of equal length. The count of replacements is surfaced as a warning in `PublishResult.warnings`. Pass `--no-moderation` on `publish` for debugging only — never on production runs, since whisper mis-transcriptions of children's invented names are the main risk.

### Whisper failure = hard stop (by default)
If whisper crashes, the orchestrator aborts with exit 1 and `fatalCaptionFailure: true` on the report. No silent no-caption videos get to production. Override with `--allow-no-captions` when you explicitly want to ship a video without captions despite the crash. `--skip-transcription` is different: it is a deliberate opt-out (sets `captionStatus: "skipped"`) and never triggers the hard stop.

### Mood fallback warning
Content items declare a mood. Only `fantasia` currently ships a template; all other moods fall back to `fantasia` and emit a warning in `PublishResult.warnings` (`⚠ No template for mood=<x>, falling back to fantasia`). Query how often this fires with `decisions --slug <slug> --json | jq .result.warnings`.

## Reading the decision log

```
postiz-agent decisions --slug dragon-marcos
```

Every line is a JSON object with `{id, action, contentSlug, platform, reason, result, createdAt}`. `result.success: false` means that platform failed; `result.error` is the raw error string. This log is the agent's memory across runs — "did yesterday's TikTok succeed?" is one grep, not a platform API re-check.

When a publish fails, always record a follow-up decision explaining what you did:

```
postiz-agent publish --slug dragon-marcos --platforms instagram --reason "retry after adding IG integration"
```

Future you, reading the log, will know why that retry exists.

## Things NOT to do

- **Do not edit `hyperframes/index.html` or `hyperframes/transcript.json` by hand.** Both are regenerated on every render. Changes will be lost. Edit templates.
- **Do not commit files under `hyperframes/assets/`, `hyperframes/renders/`, or `tmp/`.** They are generated. `.gitignore` already excludes them.
- **Do not reach for Remotion / React.** The project used to use Remotion. It was removed on purpose. See `memory/video_engine.md`.
- **Do not clip full audio items to 60-90s "for TikTok style" by default.** Clip selection is a separate product layer. See `memory/slide-pacing.md`.
- **Do not post to X via x-reader or cookie scraping.** `x-reader` is read-only on purpose. Writes go through the official API via Postiz.
- **Do not replace Postiz.** Postiz handles OAuth, scheduling, and queueing across 27 platforms. We sit in front of it, not instead of it.
- **Do not bypass `--force` on real publishes without a reason.** The 24h idempotency guard is there to prevent duplicate posts when a scheduler fires twice. `--force` exists for the rare "re-publish after fixing a mood palette" case — record a meaningful `--reason` when you use it.
- **Do not pass `--no-moderation` on production runs.** It is a debugging flag. Whisper mis-transcriptions can embarrass a brand; the blocklist is the defense.

## Scheduling (cron / launchd / systemd)

For unattended daily runs, use `dispatch` (not `publish`) so the agent picks the next unpublished item automatically. Config examples ship in `deploy/cron/`:

- `deploy/cron/crontab.example` — Linux/macOS crontab
- `deploy/cron/com.djinnfoundry.postiz-agent.plist` — macOS launchd
- `deploy/cron/README.md` — systemd timer snippet for Linux servers

Pair with `ALERT_WEBHOOK_URL` so failures surface promptly instead of sitting in `data/cron.log` until morning.

## When the user asks something ambiguous

- "Publish the launch recap" → confirm slug first: inspect `CONTENT_OUTPUT_DIR` for matching `*.json + *.mp3` pairs. Do not guess.
- "Why did IG fail yesterday?" → `decisions --platform instagram` and read the `error` field.
- "Make a video of item X for Instagram" → `render --slug X --platforms instagram`. Do not run the full `publish` unless they said publish.
- "How did last week's YouTube uploads do?" → this is a YouTubeCLI question. Switch to that tool for analytics.

## Quick self-test

Run this to confirm the full pipeline works on the test fixture:

```
postiz-agent status
postiz-agent render --slug dragon-marcos --platforms tiktok
ls tmp/dragon-marcos/dragon-marcos-tiktok.mp4
```

If those three succeed, you're wired up correctly.
