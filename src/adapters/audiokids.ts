import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { StorySchema, StorySchemaV2, type Story, type StoryV2 } from '../types.js';
import type { ContentBundle, Recipient } from '../core/content-bundle.js';
import { countSentences } from '../lib/sentences.js';
import { generateCoverSvg } from './cover-placeholder.js';

/**
 * AudioKids adapter: reads a story from the AudioKids output directory and produces a
 * neutral ContentBundle that the rest of PostizAgent consumes.
 *
 * Two layouts supported (transparently, per-story):
 *
 *   v1 (legacy, flat):
 *     <outputDir>/<slug>.json
 *     <outputDir>/<slug>.mp3
 *     <outputDir>/<slug>-cover.png  (optional)
 *
 *   v2 (current, subdir per story; introduced 2026-04):
 *     <outputDir>/<slug>/story.json
 *     <outputDir>/<slug>/<slug>.mp3   (or any single .mp3 inside the dir)
 *     <outputDir>/<slug>/cover.{png,jpg}  (optional)
 *
 * Detection is per-candidate: a v1 story sitting next to a v2 directory both work.
 * This is the ONLY place that knows the AudioKids-specific Story shape. Every other
 * tool operates on ContentBundle.
 */

export interface AudioKidsAdapterOptions {
  /**
   * When true, synthesize a deterministic SVG cover (per slug, per mood) if no real
   * cover asset is found. Off by default: downstream tools (slide-video, publishers)
   * never read `cover` directly, so a missing cover must NOT block publishing. Opt in
   * only when a caller genuinely needs a visual (thumbnail renderers, future features).
   */
  generatePlaceholder?: boolean;
  /** Defaults to `<projectRoot>/data/covers`. Overridable for tests. */
  placeholderDir?: string;
  /**
   * Side channel for non-fatal walk failures (unreadable dir entry, malformed
   * story.json, missing audio in a partially-rendered story, etc.). Default
   * routes to stderr behind `DEBUG_ADAPTER=1` so production stays quiet but
   * operators can opt in when a candidate mysteriously disappears. Tests pass
   * an assertion callback to verify the failure surfaced.
   */
  onWarn?: (message: string) => void;
}

const DEFAULT_ON_WARN: (message: string) => void = process.env.DEBUG_ADAPTER === '1'
  ? (m: string) => console.warn(`[audiokids-adapter] ${m}`)
  : () => {};

export class AudioKidsAdapter {
  private readonly generatePlaceholder: boolean;
  private readonly placeholderDir: string;
  private readonly onWarn: (message: string) => void;

  constructor(
    private readonly outputDir: string = config.audiokids.outputDir,
    options: AudioKidsAdapterOptions = {},
  ) {
    this.generatePlaceholder = options.generatePlaceholder ?? false;
    this.placeholderDir = options.placeholderDir ?? join(config.paths.projectRoot, 'data', 'covers');
    this.onWarn = options.onWarn ?? DEFAULT_ON_WARN;
  }

  loadBundle(slug: string): ContentBundle {
    const v2 = this.tryLoadV2(slug);
    if (v2) return v2;
    const v1 = this.tryLoadV1(slug);
    if (v1) return v1;
    const v2Json = join(this.outputDir, slug, 'story.json');
    const v1Json = join(this.outputDir, `${slug}.json`);
    throw new Error(
      `Story metadata not found for slug "${slug}". Tried v2 (${v2Json}) and v1 (${v1Json}).`,
    );
  }

  /**
   * List every story available in the AudioKids output directory, returning lightweight
   * candidate metadata (no full parse) for dispatch selection. Full parse happens at
   * publish time via loadBundle(). Walks the dir once, classifying each entry as v2
   * (subdir with story.json) or v1 (flat .json+.mp3 pair) and emitting at most one
   * candidate per slug.
   */
  listCandidates(): Array<{ slug: string; mtimeMs: number; generatedAt?: string }> {
    if (!existsSync(this.outputDir)) return [];
    const out: Array<{ slug: string; mtimeMs: number; generatedAt?: string }> = [];
    const seen = new Set<string>();
    let entries: string[];
    try {
      entries = readdirSync(this.outputDir);
    } catch (err) {
      this.onWarn(`readdirSync(${this.outputDir}) failed: ${describe(err)}`);
      return [];
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(this.outputDir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch (err) {
        this.onWarn(`statSync(${fullPath}) failed: ${describe(err)}`);
        continue;
      }

      if (st.isDirectory()) {
        // v2 candidate
        const slug = entry;
        if (seen.has(slug)) continue;
        const candidate = this.candidateFromV2Dir(slug, fullPath);
        if (candidate) {
          out.push(candidate);
          seen.add(slug);
        }
        continue;
      }

      if (st.isFile() && entry.endsWith('.json')) {
        const slug = entry.replace(/\.json$/, '');
        if (seen.has(slug)) continue;
        const candidate = this.candidateFromV1Json(slug);
        if (candidate) {
          out.push(candidate);
          seen.add(slug);
        }
      }
    }
    return out;
  }

  // ─── v2 (subdir + story.json) ──────────────────────────────────────────

  private tryLoadV2(slug: string): ContentBundle | null {
    const dir = join(this.outputDir, slug);
    const jsonPath = join(dir, 'story.json');
    if (!existsSync(jsonPath)) return null;
    const audioPath = this.findV2Audio(slug, dir);
    if (!audioPath) {
      throw new Error(
        `AudioKids v2 story "${slug}" has story.json at ${jsonPath} but no .mp3 inside ${dir}. Re-run the AudioKids pipeline.`,
      );
    }
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const parsed = StorySchemaV2.parse(raw);
    const cover = this.resolveV2Cover(slug, dir, parsed);
    const recipient = deriveRecipientV2(parsed);
    const wordCount = countWords(parsed.story.content);
    const sentenceCount = countSentences(parsed.story.content);
    const estimatedDurationMin = parsed.job.targetDurationMin ?? estimateDurationMin(wordCount);
    const generatedAt = parseTimestampFromSlug(slug) ?? statSync(jsonPath).mtime.toISOString();

    return {
      id: slug,
      kind: 'audio-story',
      primaryMedia: audioPath,
      ...(cover ? { cover } : {}),
      text: {
        title: parsed.story.title,
        body: parsed.story.content,
      },
      locale: parsed.job.locale,
      theme: { mood: parsed.job.mood },
      ...(recipient ? { recipient } : {}),
      ...(parsed.story.beats ? { beats: parsed.story.beats } : {}),
      sourceMeta: {
        // Keys downstream tools already read (caption-builder, orchestrator, youtube):
        slug,
        wordCount,
        sentenceCount,
        estimatedDurationMin,
        vocabularioNuevo: parsed.story.vocabulary ?? [],
        generatedAt,
        // v2-only escape hatch — not consumed today, kept so a future tool can introspect:
        schemaVersion: 'v2',
        job: parsed.job,
        chapters: parsed.story.chapters,
        assessmentQuestions: parsed.story.assessmentQuestions,
      },
    };
  }

  private candidateFromV2Dir(
    slug: string,
    dir: string,
  ): { slug: string; mtimeMs: number; generatedAt?: string } | null {
    const jsonPath = join(dir, 'story.json');
    if (!existsSync(jsonPath)) return null;
    if (!this.findV2Audio(slug, dir)) return null;
    const st = statSync(jsonPath);
    const generatedAt = parseTimestampFromSlug(slug);
    return {
      slug,
      mtimeMs: st.mtimeMs,
      ...(generatedAt ? { generatedAt } : {}),
    };
  }

  private findV2Audio(slug: string, dir: string): string | undefined {
    const named = join(dir, `${slug}.mp3`);
    if (existsSync(named)) return named;
    // Fallback: any single .mp3 sitting at the top level (skip chunks/ subdir)
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      this.onWarn(`v2 audio readdir(${dir}) failed: ${describe(err)}`);
      return undefined;
    }
    const mp3s = entries.filter(f => f.endsWith('.mp3'));
    if (mp3s.length === 1) return join(dir, mp3s[0]);
    return undefined;
  }

  private resolveV2Cover(slug: string, dir: string, parsed: StoryV2): string | undefined {
    const found = this.findV2Cover(slug, dir);
    if (found) return found;
    if (this.generatePlaceholder) {
      return this.writePlaceholder(slug, parsed.story.title, parsed.job.mood);
    }
    return undefined;
  }

  private findV2Cover(slug: string, dir: string): string | undefined {
    const candidates = [
      join(dir, 'cover.png'),
      join(dir, 'cover.jpg'),
      join(dir, `${slug}.png`),
      join(dir, `${slug}-cover.png`),
      join(dir, `${slug}.jpg`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  // ─── v1 (legacy flat) ──────────────────────────────────────────────────

  private tryLoadV1(slug: string): ContentBundle | null {
    const jsonPath = join(this.outputDir, `${slug}.json`);
    const mp3Path = join(this.outputDir, `${slug}.mp3`);
    if (!existsSync(jsonPath)) return null;
    if (!existsSync(mp3Path)) {
      throw new Error(`Story audio not found: ${mp3Path}. Run the AudioKids pipeline first.`);
    }
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const story: Story = StorySchema.parse(raw);
    const cover = this.resolveV1Cover(slug, story);
    const recipient = deriveRecipientV1(story);

    return {
      id: slug,
      kind: 'audio-story',
      primaryMedia: mp3Path,
      ...(cover ? { cover } : {}),
      text: {
        title: story.titulo,
        body: story.contenido,
      },
      locale: story.meta.locale,
      theme: { mood: story.mood },
      ...(recipient ? { recipient } : {}),
      ...(story.beats ? { beats: story.beats } : {}),
      sourceMeta: { ...story.meta, vocabularioNuevo: story.vocabularioNuevo ?? [] },
    };
  }

  private candidateFromV1Json(
    slug: string,
  ): { slug: string; mtimeMs: number; generatedAt?: string } | null {
    const jsonPath = join(this.outputDir, `${slug}.json`);
    const mp3Path = join(this.outputDir, `${slug}.mp3`);
    if (!existsSync(mp3Path)) return null;
    const st = statSync(jsonPath);
    let generatedAt: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const parsed = StorySchema.safeParse(raw);
      if (parsed.success) generatedAt = parsed.data.meta.generatedAt;
      else this.onWarn(`v1 candidate ${slug}: schema mismatch on ${jsonPath}: ${parsed.error.message}`);
    } catch (err) {
      this.onWarn(`v1 candidate ${slug}: parse failed for ${jsonPath}: ${describe(err)}`);
    }
    return { slug, mtimeMs: st.mtimeMs, ...(generatedAt ? { generatedAt } : {}) };
  }

  private resolveV1Cover(slug: string, story: Story): string | undefined {
    const found = this.findV1Cover(slug, story);
    if (found) return found;
    if (this.generatePlaceholder) return this.writePlaceholder(slug, story.titulo, story.mood);
    return undefined;
  }

  private findV1Cover(slug: string, story: Story): string | undefined {
    const candidates = [
      join(this.outputDir, `${slug}-cover.png`),
      join(this.outputDir, `${slug}.png`),
      join(this.outputDir, 'covers', `${slug}.png`),
      join(config.paths.assetsDir, 'covers', `${story.mood}.png`),
      join(config.paths.assetsDir, 'cover-default.png'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  // ─── shared ────────────────────────────────────────────────────────────

  private writePlaceholder(slug: string, title: string, mood: string): string {
    const target = join(this.placeholderDir, `${slug}.svg`);
    mkdirSync(dirname(target), { recursive: true });
    const svg = generateCoverSvg({ slug, title, mood });
    writeFileSync(target, svg, 'utf-8');
    return target;
  }
}

/**
 * v1: AudioKids stored `name` and `age` at the top level of meta, without explicit consent.
 * We default to `first-name-only` (safest for kids' content) until the pipeline emits an
 * explicit `recipient` block. When AudioKids starts writing `meta.recipient` directly,
 * we pick that up verbatim.
 */
function deriveRecipientV1(story: Story): Recipient | undefined {
  const metaRecipient = (story.meta as Record<string, unknown>).recipient;
  if (metaRecipient && typeof metaRecipient === 'object') {
    return metaRecipient as Recipient;
  }
  const name = story.meta.name?.trim();
  if (!name) return undefined;
  return {
    name,
    age: story.meta.age,
    shareConsent: 'first-name-only',
  };
}

/**
 * v2: recipient lives in `job` (childName, childAge, childInterests). Same default
 * consent as v1 (first-name-only) until AudioKids surfaces an explicit shareConsent
 * choice. childName can be null/empty for synthetic/anonymous stories — emit no
 * recipient in that case so consent defaults don't accidentally name a missing child.
 */
function deriveRecipientV2(parsed: StoryV2): Recipient | undefined {
  const name = parsed.job.childName?.trim();
  if (!name) return undefined;
  const interests = parsed.job.childInterests?.length
    ? parsed.job.childInterests
    : undefined;
  const recipient: Recipient = {
    name,
    shareConsent: 'first-name-only',
  };
  const age = parsed.job.childAge;
  if (typeof age === 'number') recipient.age = age;
  if (interests) recipient.interests = interests;
  return recipient;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Compact description of any thrown value for diagnostic logs. Errors get
 *  their `code` prefix when present (ENOENT, EACCES, etc.) so the operator
 *  can spot a permissions issue from one line of output. */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** Approximate narrator pace at ~160 wpm. Used only when the v2 job omits targetDurationMin. */
function estimateDurationMin(wordCount: number): number {
  return Math.max(0.1, Math.round((wordCount / 160) * 100) / 100);
}

/**
 * AudioKids v2 slugs end with a timestamp like `-2026-04-26T15-34-00-123Z`. Parse it
 * back into a real ISO timestamp so the dispatch order matches generation order even
 * when fs mtime gets touched (rsync, backup restore, etc.). Returns undefined when
 * the slug doesn't have the expected suffix.
 */
function parseTimestampFromSlug(slug: string): string | undefined {
  const m = slug.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!m) return undefined;
  // slug format uses dashes between H-M-S-ms; ISO uses : and . — restore them
  const iso = m[1].replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}
