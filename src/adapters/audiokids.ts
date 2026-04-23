import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { StorySchema, type Story } from '../types.js';
import type { ContentBundle, Recipient } from '../core/content-bundle.js';
import { generateCoverSvg } from './cover-placeholder.js';

/**
 * AudioKids adapter: reads a <slug>.json + <slug>.mp3 + cover from the AudioKids output
 * directory and produces a neutral ContentBundle that the rest of PostizAgent consumes.
 *
 * This is the ONLY place that knows the AudioKids-specific `Story` shape. Every other
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
}

export class AudioKidsAdapter {
  private readonly generatePlaceholder: boolean;
  private readonly placeholderDir: string;

  constructor(
    private readonly outputDir: string = config.audiokids.outputDir,
    options: AudioKidsAdapterOptions = {},
  ) {
    this.generatePlaceholder = options.generatePlaceholder ?? false;
    this.placeholderDir = options.placeholderDir ?? join(config.paths.projectRoot, 'data', 'covers');
  }

  loadBundle(slug: string): ContentBundle {
    const jsonPath = join(this.outputDir, `${slug}.json`);
    const mp3Path = join(this.outputDir, `${slug}.mp3`);

    if (!existsSync(jsonPath)) {
      throw new Error(`Story metadata not found: ${jsonPath}`);
    }
    if (!existsSync(mp3Path)) {
      throw new Error(`Story audio not found: ${mp3Path}. Run the AudioKids pipeline first.`);
    }

    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const story: Story = StorySchema.parse(raw);
    const cover = this.resolveCover(slug, story);
    const recipient = deriveRecipient(story);

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
      sourceMeta: story.meta,
    };
  }

  /**
   * List every story available in the AudioKids output directory, returning lightweight
   * candidate metadata (no full parse) for dispatch selection. Full parse happens at
   * publish time via loadBundle().
   */
  listCandidates(): Array<{ slug: string; mtimeMs: number; generatedAt?: string }> {
    if (!existsSync(this.outputDir)) return [];
    const entries = readdirSync(this.outputDir).filter(f => f.endsWith('.json'));
    const out: Array<{ slug: string; mtimeMs: number; generatedAt?: string }> = [];
    for (const f of entries) {
      const slug = f.replace(/\.json$/, '');
      const jsonPath = join(this.outputDir, f);
      const mp3Path = join(this.outputDir, `${slug}.mp3`);
      if (!existsSync(mp3Path)) continue;
      const st = statSync(jsonPath);
      let generatedAt: string | undefined;
      try {
        const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        const parsed = StorySchema.safeParse(raw);
        if (parsed.success) generatedAt = parsed.data.meta.generatedAt;
      } catch {
        /* skip invalid candidate */
      }
      out.push({ slug, mtimeMs: st.mtimeMs, ...(generatedAt ? { generatedAt } : {}) });
    }
    return out;
  }

  private resolveCover(slug: string, story: Story): string | undefined {
    const found = this.findCover(slug, story);
    if (found) return found;
    if (this.generatePlaceholder) return this.writePlaceholder(slug, story);
    return undefined;
  }

  private findCover(slug: string, story: Story): string | undefined {
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

  private writePlaceholder(slug: string, story: Story): string {
    const target = join(this.placeholderDir, `${slug}.svg`);
    mkdirSync(dirname(target), { recursive: true });
    const svg = generateCoverSvg({ slug, title: story.titulo, mood: story.mood });
    writeFileSync(target, svg, 'utf-8');
    return target;
  }
}

/**
 * AudioKids stores `name` and `age` at the top level of meta, without explicit consent.
 * We default to `first-name-only` (safest for kids' content) until the pipeline emits an
 * explicit `recipient` block. When AudioKids starts writing `meta.recipient` directly,
 * we pick that up verbatim.
 */
function deriveRecipient(story: Story): Recipient | undefined {
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
