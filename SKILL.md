---
name: postiz-agent
description: Daily autonomous publishing of AudioKids audio stories to X, TikTok, Instagram, YouTube, and Spotify (RSS). Use when asked to publish a story, preview what a story will look like on social, build podcast RSS feeds, check publishing history, or add new mood-themed visual templates.
---

# postiz-agent

This is your operating manual. Follow it before inventing a new workflow — the tool already has the primitive you need in most cases.

## What this tool does

Given an AudioKids story slug, one invocation:

1. Reads the story audio (MP3), metadata (JSON), and cover art from the AudioKids output directory.
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

This checks: ffmpeg, whisper, npx, Postiz API reachability, POSTIZ_API_KEY present, AudioKids output dir exists, YouTubeCLI path exists. If required checks fail, fix them before proceeding — publishing will fail in a confusing way otherwise.

## The daily publishing workflow

```
1. postiz-agent status                                   # sanity check
2. postiz-agent render --slug <slug> --platforms tiktok  # preview one platform
3. (inspect tmp/<slug>/<slug>-tiktok.mp4 manually)
4. postiz-agent publish --slug <slug>                    # full publish, all platforms
5. postiz-agent decisions --slug <slug>                  # verify what happened
```

Do **not** skip the render step unless the user has explicitly told you to run autonomously. A broken mood template or a whisper mis-alignment wastes API calls and floods the user's feed with bad content.

## Commands — quick reference

| Command | Purpose | Exit codes |
|---------|---------|------------|
| `status` | Environment health check | 0 ok, 1 if required deps missing |
| `integrations` | List connected Postiz OAuth accounts | 0 ok, 1 if Postiz unreachable |
| `render --slug X --platforms ...` | Build MP4s, no upload | 0 ok, 1 on render failure |
| `publish --slug X --platforms ...` | Full pipeline: render + upload | 0 all succeeded, 1 any failed |
| `rss --output feed.xml` | Rebuild Spotify podcast feed | always 0 unless write fails |
| `decisions --slug X --platform P` | Query publish history | always 0 |

Every command accepts `--help` with examples. Commands that emit JSON also accept `--json` for agent-friendly output (one line, no ANSI).

## Flag conventions

- `--slug` is the basename of the AudioKids output files (e.g. `dragon-marcos` for `dragon-marcos.mp3` + `dragon-marcos.json`). Never fabricate one.
- `--platforms` is comma-separated: `x,tiktok,instagram,youtube,spotify`. `spotify` is a valid target but produces no per-story output — it relies on the RSS feed.
- `--dry-run` (publish only) renders videos but skips uploads. Equivalent to running `render` except the decision log records intent.
- `--skip-transcription` turns off whisper. Videos will have no captions. Only use if whisper is broken and you want to still get a video out, or if the audio is non-speech.
- `--reason` (publish only) is a free-text string recorded in the decision log. Use this when the action is something other than the default daily schedule — e.g. `--reason "re-publish after fixing mood palette"`.
- `--json` on `status`, `publish`, `render`, `decisions`, `integrations` switches to machine-readable output.

## Platform-specific behavior you need to know

### X / Twitter
- Default 2-minute hard limit. Cuentos over 2min require X Premium on the account (4h limit) — the user has opted to pay for this.
- Needs Postiz connected with `X_API_KEY` + `X_API_SECRET` in `deploy/.env`. Uses OAuth 1.0a; tokens do not auto-refresh.
- If publish returns `403`, it's usually a transitional bug after a pay-per-use migration. Check `integrations` and retry once.

### TikTok
- Up to 10 minutes per post. All cuentos fit comfortably.
- The Postiz app requires production review on TikTok's side (5-10 days). Do not assume it's set up without running `integrations` first.

### Instagram
- Reels cap at 3 minutes. For longer cuentos, split into multi-part posts with `Parte 1/N`, `Parte 2/N` in the caption. (The splitter is task #15 on the roadmap — if the user asks about it before it exists, confirm you'll build it.)
- Requires a Business or Creator account linked to a Facebook Page.

### YouTube
- No duration limit. We render a 16:9 variant and hand it to YouTubeCLI.
- YouTubeCLI has its own decision log, analytics, and competitive-research tools. Prefer those for YouTube-specific questions ("how did last week's audiocuento perform?"). Don't try to re-implement them here.

### Spotify (and Apple Podcasts, Amazon Music)
- There is no per-episode publishing API for indie podcasters. We host an RSS feed; the platforms poll it.
- After each new story, regenerate: `postiz-agent rss --output ./tmp/feed.xml`, then upload `feed.xml` + the MP3s to the public R2 bucket. Submit the feed URL once at podcasters.spotify.com; updates are automatic.

## Adding a new mood template

AudioKids stories have a `mood` field: `aventura`, `calma`, `comedia`, `misterio`, `emocionante`, `fantasia`, `naturaleza`. Currently only `fantasia` has a template; the others fall through to it as a fallback.

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

## Reading the decision log

```
postiz-agent decisions --slug dragon-marcos
```

Every line is a JSON object with `{id, action, storySlug, platform, reason, result, createdAt}`. `result.success: false` means that platform failed; `result.error` is the raw error string. This log is the agent's memory across runs — "did yesterday's TikTok succeed?" is one grep, not a platform API re-check.

When a publish fails, always record a follow-up decision explaining what you did:

```
postiz-agent publish --slug dragon-marcos --platforms instagram --reason "retry after adding IG integration"
```

Future you, reading the log, will know why that retry exists.

## Things NOT to do

- **Do not edit `hyperframes/index.html` or `hyperframes/transcript.json` by hand.** Both are regenerated on every render. Changes will be lost. Edit templates.
- **Do not commit files under `hyperframes/assets/`, `hyperframes/renders/`, or `tmp/`.** They are generated. `.gitignore` already excludes them.
- **Do not reach for Remotion / React.** The project used to use Remotion. It was removed on purpose. See `memory/video_engine.md`.
- **Do not clip stories to 60-90s "for TikTok style".** Stories run at narration pace. The user has been explicit: this is a book, not a song. See `memory/slide-pacing.md`.
- **Do not post to X via x-reader or cookie scraping.** `x-reader` is read-only on purpose. Writes go through the official API via Postiz.
- **Do not replace Postiz.** Postiz handles OAuth, scheduling, and queueing across 27 platforms. We sit in front of it, not instead of it.

## When the user asks something ambiguous

- "Publish the dragon story" → confirm slug first: `ls $AUDIOKIDS_OUTPUT_DIR/*.json | grep -i dragon`. Do not guess.
- "Why did IG fail yesterday?" → `decisions --platform instagram` and read the `error` field.
- "Make a video of story X for Instagram" → `render --slug X --platforms instagram`. Do not run the full `publish` unless they said publish.
- "How did last week's audiocuentos do?" → this is a YouTubeCLI question. Switch to that tool for analytics.

## Quick self-test

Run this to confirm the full pipeline works on the test fixture:

```
postiz-agent status
postiz-agent render --slug dragon-marcos --platforms tiktok
ls tmp/dragon-marcos/dragon-marcos-tiktok.mp4
```

If those three succeed, you're wired up correctly.
