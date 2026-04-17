# PostizAgent

**Autonomous daily-publishing agent for [AudioKids](../audiokids) audio stories.**

Turns one MP3 cuento into five platform-ready posts (X, TikTok, Instagram Reels, YouTube, Spotify) and lets an LLM agent run the whole thing end-to-end, unattended.

---

## Why this exists (and not just Postiz)

[Postiz](https://github.com/gitroomhq/postiz-app) is a great social scheduler: 27+ platforms, OAuth handled, posts get published. But Postiz is **content-agnostic**. It assumes you already have a finished post ready to upload.

AudioKids produces MP3 audio files. None of the platforms we care about accept raw audio:

| Platform | Accepts MP3? | What they want |
|----------|-------------|----------------|
| X | No | Video (MP4, 4h on Premium) |
| TikTok | No | Vertical video (9:16, up to 10min) |
| Instagram Reels | No | Vertical video (9:16, up to 3min — multi-part for longer) |
| YouTube | No | Video (16:9 preferred, no duration limit) |
| Spotify | Yes (but) | Submitted via RSS, no direct API |

So between AudioKids and Postiz there is a **gap** that Postiz alone won't fill:

```
AudioKids (MP3 + text + beats)            Postiz (posts whatever you give it)
         │                                        ▲
         └── ?????????????????????????????────────┘
                       gap
```

PostizAgent fills that gap. It does the domain-specific work Postiz can't know about:

1. **Editorial slide video** — MP3 + whisper word-timestamps → MP4 with book-page slides, Fraunces serif, per-word karaoke progression ([HyperFrames](https://hyperframes.heygen.com) + GSAP)
2. **Mood-aware templates** — each AudioKids mood (`fantasia`, `aventura`, `comedia`, `misterio`...) maps to a distinct visual identity, auto-selected from story metadata
3. **Multi-aspect rendering** — same story, one command, three canvases (1:1 for X, 9:16 for TikTok/IG, 16:9 for YouTube)
4. **Platform routing** — YouTube goes via [YouTubeCLI](../youtubecli) (analytics, decision logging, 42 MCP tools), not Postiz. Spotify goes via RSS, not Postiz at all.
5. **Agent-friendly interface** — single CLI command, deterministic JSON output, exit codes, decision log
6. **Reusable transcription** — whisper runs once per story, all three video variants share the same word-level timestamps

---

## Capability matrix: Postiz alone vs PostizAgent

| Capability | Postiz (vanilla) | PostizAgent |
|------------|:---------------:|:-----------:|
| OAuth to X/TikTok/IG/YT | ✓ | ✓ (delegates to Postiz) |
| Schedule posts | ✓ | ✓ (delegates to Postiz) |
| Upload video to a platform | ✓ | ✓ (delegates to Postiz) |
| Convert audio → video | ✗ | ✓ (HyperFrames) |
| Per-platform aspect ratios (1:1, 9:16, 16:9) | partial | ✓ (full pipeline) |
| Mood-themed visual templates | ✗ | ✓ (7 moods, one per identity) |
| Word-level karaoke captions synced to narration | ✗ | ✓ (Whisper + GSAP) |
| Spotify / Apple Podcasts | ✗ | ✓ (RSS feed) |
| YouTube with analytics + decision log | ✗ | ✓ (via YouTubeCLI) |
| Agent-first CLI (structured JSON, exit codes) | partial | ✓ |
| Decision log (action + reason + outcome) | ✗ | ✓ |
| AudioKids-aware (reads mood, vocab, beats) | ✗ | ✓ |
| One command publishes to all platforms | ✗ (one UI action per platform) | ✓ |

In short: **Postiz is a hand. PostizAgent is the brain that moves the hand.**

---

## What an agent can do with it

The whole system reduces daily publishing to a single invocation:

```bash
postiz-agent publish --slug dragon-marcos --platforms x,tiktok,instagram,youtube
```

Output is structured JSON:

```json
{
  "slug": "dragon-marcos",
  "results": [
    { "platform": "x", "success": true, "postId": "...", "url": "..." },
    { "platform": "tiktok", "success": true, "postId": "...", "url": "..." },
    { "platform": "instagram", "success": true, "postId": "...", "url": "..." },
    { "platform": "youtube", "success": true, "postId": "abc123", "url": "https://youtu.be/abc123" }
  ]
}
```

Exit code `0` if everything succeeded, `1` if anything failed. Every attempt is appended to `data/decisions.jsonl` with the reason and outcome.

---

## Architecture

```
AudioKids output dir
(slug.mp3, slug.json, slug-cover.png)
            │
            ▼
    ┌─────────────────┐
    │   Orchestrator  │  reads story, runs whisper once,
    │                 │  iterates over platforms
    └────────┬────────┘
             │ words[] (word-level transcript)
             ▼
    ┌─────────────────────────────┐
    │   PlatformPublisher         │
    │     └─ SlideVideoBuilder    │  HTML template (mood) + audio + words
    └─┬──────┬──────┬──────┬──────┘
      │      │      │      │
      ▼      ▼      ▼      ▼
      X    TikTok  IG    YouTube         Spotify
      │      │      │      │                │
      └──────┴──────┘      │                │
            │              │                │
            ▼              ▼                ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  Postiz API  │  │  YouTubeCLI  │  │  RSS feed    │
    │ (self-host)  │  │ (Elixir+MCP) │  │ (R2 public)  │
    └──────────────┘  └──────────────┘  └──────────────┘
```

### File layout

```
src/
├── cli.ts                    # commander entry (publish, rss, decisions)
├── orchestrator.ts           # loop: story → transcript → publishers → decision log
├── config.ts, types.ts       # env + zod schemas
│
├── lib/
│   ├── process.ts            # run(cmd, args) promise-wrapped spawn
│   └── ffprobe.ts            # duration / dimension probing
│
├── audiokids/reader.ts       # reads story JSON/MP3/cover from AudioKids output
│
├── media/
│   ├── subtitles.ts          # whisper CLI → word-level JSON (cached)
│   ├── whisper-json.ts       # parser + flattener
│   └── slide-video.ts        # stages assets & drives HyperFrames render
│
├── platforms/
│   ├── base.ts               # PlatformPublisher + VideoPublisher
│   ├── registry.ts           # platform → publisher
│   ├── postiz.ts             # Postiz public API client (X, TikTok, IG)
│   ├── youtube.ts            # shells out to YouTubeCLI
│   ├── x-publisher.ts        # ─┐
│   ├── tiktok-publisher.ts   #  ├─ each implements upload()
│   ├── instagram-publisher.ts#  │
│   ├── youtube-publisher.ts  # ─┤
│   ├── spotify-publisher.ts  # ─┘ no-op (RSS handles it)
│   └── spotify-rss.ts        # builds iTunes-compatible feed
│
└── decisions/log.ts          # JSONL decision log

hyperframes/                  # HyperFrames project (Apache-2.0, HeyGen)
├── index.html                # generated per render
├── transcript.json           # generated per render
├── assets/narration.mp3      # staged per render
├── hyperframes.json          # project config
└── templates/
    ├── common.mjs            # shared helpers (palette, page grouping)
    └── fantasia.mjs          # mood-specific generator (more to come)

deploy/
├── docker-compose.yml        # Postiz self-hosted
└── README.md                 # setup instructions
```

### Why this shape

**HyperFrames over Remotion.** We originally built this on Remotion (React-based video programming). Migrated to HyperFrames because:
- Templates are plain HTML + CSS + GSAP — agents can generate new moods without knowing React
- 50+ pre-built blocks (shader transitions, social overlays) available via `npx hyperframes add`
- 40% smaller output at equivalent quality
- Installable as a Claude Code skill (`npx skills add heygen-com/hyperframes`), so new agents discover it automatically

**Strategy pattern per platform.** Each platform is a `VideoPublisher` subclass that implements `upload(videoPath, ctx)`. The base class handles the common flow (video build → dry-run short-circuit → error capture). Adding a new platform is: new file, one method, one line in the registry.

**Transcription runs once.** Whisper processes the MP3 and caches the JSON in `tmp/<slug>/`. All three video variants (X 1:1, TikTok/IG 9:16, YouTube 16:9) consume the same word-level timestamps.

**YouTube is different.** Postiz can upload to YouTube, but it has none of the capabilities YouTubeCLI already has: 42 MCP tools, decision log with result measurement, competitive research, analytics. Delegating to YouTubeCLI is a one-line shell-out that gives us all of that for free.

**Spotify is different too.** There is no Spotify publishing API for independent podcasters. The only path is RSS. We build a feed from AudioKids output and submit it once at `podcasters.spotify.com`.

---

## The pieces Postiz doesn't know anything about

These are genuinely outside Postiz's scope. Any Postiz user who wants them has to build them themselves:

1. **`hyperframes/templates/fantasia.mjs`** — 100 lines of deterministic HTML generation. Takes a story JSON (title, byline, words[], aspect ratio) on stdin, emits `index.html` with:
   - Parchment cream background + soft radial glows
   - 2s intro card with title + byline in Fraunces 108px
   - Book-page slides (15-25 words each, break on sentence terminators)
   - GSAP timeline that recolours each `<span>` at its word timestamp
   - Brand strip footer

2. **`hyperframes/templates/common.mjs`** — shared helpers (page grouping algorithm, GSAP timeline emission, HTML escaping) that future mood templates reuse.

3. **`src/media/slide-video.ts`** — stages the MP3 + transcript into the HyperFrames project, pipes story data into the mood template, runs `npx hyperframes lint` then `npx hyperframes render --output ...`. Returns the output MP4 path.

4. **`src/media/subtitles.ts`** — whisper CLI integration with disk caching. The first call transcribes, subsequent calls on the same audio reuse the JSON.

5. **`src/platforms/spotify-rss.ts`** — iTunes-compatible RSS generator. Walks the AudioKids output dir, parses each story JSON, probes MP3 duration, renders `<item>` entries. Submit once at podcasters.spotify.com and Spotify polls it.

6. **`src/decisions/log.ts`** — JSONL decision log. Every `publish.<platform>` call appends `{action, reason, storySlug, platform, result, createdAt}`. Query with `postiz-agent decisions --slug ... --platform ...`.

---

## Costs

For 1 story/day across all 5 platforms:

| Platform | API cost | Setup |
|----------|----------|-------|
| X | ~$0.01–0.07 per post → **~$2/month** (or $8 X Premium for 4h video limit) | developer.x.com, Native App |
| TikTok | **free** | developers.tiktok.com, production review (5-10 days) |
| Instagram | **free** | Meta App, Business/Creator IG account |
| YouTube | **free** (quota-based) | Google Cloud project |
| Spotify | **free** | RSS submission only |

**Total: ~$2-10/month.** Everything else is free.

---

## Quick start

```bash
# 1. install
pnpm install
npx skills add heygen-com/hyperframes  # agent skills for HyperFrames (optional)

# 2. configure
cp .env.example .env
# edit POSTIZ_API_URL, POSTIZ_API_KEY, AUDIOKIDS_OUTPUT_DIR

# 3. deploy Postiz self-hosted (one-time)
cd deploy
cp .env.example .env       # add X_API_KEY, X_API_SECRET, etc.
docker compose up -d
# open http://localhost:5000, connect each platform via OAuth
# copy Postiz API key back to the root .env

# 4. publish (dry-run first — builds videos locally, uploads nothing)
pnpm dev publish --slug dragon-marcos --platforms tiktok --dry-run

# 5. real publish
pnpm dev publish --slug dragon-marcos --platforms x,tiktok,instagram,youtube

# 6. regenerate podcast feed (after each new story)
pnpm dev rss --output ./tmp/feed.xml
# upload feed.xml + MP3s to your public bucket; Spotify polls hourly
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `publish --slug X --platforms ...` | Full pipeline: transcribe + generate + publish |
| `publish ... --dry-run` | Generate videos locally, don't upload |
| `publish ... --skip-transcription` | Skip whisper (videos will have no captions) |
| `rss --output ./feed.xml` | Regenerate Spotify RSS feed |
| `decisions --slug X --platform Y` | Query the decision log |

### Adding a new mood template

1. Create `hyperframes/templates/<mood>.mjs` — copy `fantasia.mjs` as a starting point
2. Change the palette, typography, and layout to match the mood
3. AudioKids stories with `mood: "<mood>"` in their metadata automatically use it

HyperFrames templates are pure HTML + CSS + GSAP, so an agent can write new ones directly. Run `npx hyperframes preview` in the `hyperframes/` folder for live reload while iterating.

---

## Not doing (intentionally)

- **Replacing Postiz.** Postiz already handles OAuth, scheduling, queueing, and 27 platforms.
- **Replacing YouTubeCLI.** It already has everything we'd want for YouTube management.
- **Scraping or cookie-based X posting.** The [x-reader](../x-reader) project uses X cookies for read operations, but writes through unofficial endpoints risk account suspension. The official API costs ~$2/month.
- **A UI.** This is an agent tool, not a dashboard. Postiz's own UI handles all interactive scheduling.

---

## License

Private. Internal to the AudioKids/Djinn Foundry toolkit.
