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

Each video is a slide-based composition: book-page pacing (15–25 words per slide), current-word highlight, narrator's voice as the audio track. The visual identity is driven by the story's `mood` field (`fantasia`, `aventura`, `calma`, `comedia`, `misterio`, `emocionante`, `naturaleza`) — one HTML template per mood. The first one shipped is `fantasia`.

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

| Command | What it does |
|---|---|
| `dispatch` | Autonomously pick the next story not yet published and run it. Cron-safe. |
| `status` | Env health check — run this first |
| `integrations` | List connected Postiz accounts |
| `render --slug <s> --platforms <list>` | Build MP4s, no upload |
| `publish --slug <s> --platforms <list>` | Render + upload to each platform |
| `rss --output <path>` | Rebuild the Spotify/Apple RSS feed |
| `decisions [--slug s] [--platform p]` | Query the JSONL publish history |

Every command supports `--help`. `dispatch`, `publish`, `render`, `status`, `integrations`, and `decisions` support `--json` for agent-readable output.

## Architecture

```
src/
├── cli.ts                   # commander entrypoint; 6 subcommands
├── orchestrator.ts          # loop: story → transcript → publishers → decision log
├── config.ts · types.ts
│
├── audiokids/reader.ts      # read the story assets from AudioKids output
├── media/
│   ├── subtitles.ts         # whisper CLI → word-level JSON (disk-cached)
│   ├── whisper-json.ts      # parser
│   └── slide-video.ts       # stages assets, drives `npx hyperframes render`
│
├── platforms/
│   ├── base.ts              # PlatformPublisher + VideoPublisher strategy base
│   ├── registry.ts          # platform → publisher
│   ├── postiz.ts            # Postiz public API client (upload + create post)
│   ├── youtube.ts           # shells out to YouTubeCLI
│   ├── {x,tiktok,instagram,youtube,spotify}-publisher.ts
│   └── spotify-rss.ts       # builds iTunes-format podcast feed
│
├── decisions/log.ts         # JSONL append-only decision log
└── lib/{process,ffprobe}.ts

hyperframes/                 # HyperFrames project (HTML → MP4, HeyGen/Apache-2.0)
├── hyperframes.json · CLAUDE.md · AGENTS.md
└── templates/
    ├── common.mjs           # buildPages, palette, HTML base
    └── fantasia.mjs         # mood template (more coming)

deploy/
├── docker-compose.yml       # self-hosted Postiz + Postgres + Redis
└── README.md                # OAuth setup walkthrough
```

### Why this shape

- **One publisher per file, uniform base class.** Adding a platform is: new file + one method + one line in `registry.ts`. Keeps each platform's quirks isolated.
- **Transcription runs once.** Whisper processes the MP3 and caches the JSON. All three video variants consume the same timestamps.
- **YouTube is delegated to YouTubeCLI.** It already has analytics, competitive research, and its own decision log (42 MCP tools). We shell out, we don't reimplement.
- **Spotify is RSS, not API.** There is no per-episode publishing endpoint for indie podcasters. We host a feed; the platforms poll it.
- **Video templates are plain HTML + GSAP, not React.** This project originally used Remotion. We migrated to HyperFrames because an agent can write new mood templates in HTML+CSS+GSAP directly. The output is also 40% smaller at equivalent quality.
- **Decision log is JSONL, not SQL.** Append-only, trivially greppable, human-readable. The agent's memory across runs.

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

Shipping:
- End-to-end publish pipeline (status ok → render → upload → log)
- `fantasia` mood template
- Whisper transcription with caching
- Spotify RSS generator
- Decision log with CLI query
- Self-hosted Postiz docker-compose

Roadmap:
- Mood templates for `aventura`, `calma`, `comedia`, `misterio`, `emocionante`, `naturaleza`
- Automatic multi-part splitting for IG Reels when a cuento exceeds 3 minutes
- Scheduled publishing (currently everything is immediate)

## License

Internal to the DjinnFoundry / AudioKids toolkit.

---

## For agents

See [`SKILL.md`](./SKILL.md) for workflow heuristics, platform quirks, and things to avoid. It's the contract this repo publishes for LLM agents to consume.
