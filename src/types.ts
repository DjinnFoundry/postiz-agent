import { z } from 'zod';

export const MoodSchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i);
export type Mood = z.infer<typeof MoodSchema>;

export const BeatSchema = z.object({
  t_ms: z.number(),
  type: z.string(),
  leitmotif: z.string().optional(),
  ambience: z.string().optional(),
  intensity: z.enum(['low', 'mid', 'high']).optional(),
  sceneTags: z.array(z.string()).optional(),
  sfx: z.array(z.object({
    id: z.string(),
    anchorWord: z.string().optional(),
    tier: z.string().optional(),
  })).optional(),
});
export type Beat = z.infer<typeof BeatSchema>;

const CanonicalMetaSchema = z.object({
  slug: z.string(),
  mood: MoodSchema.optional(),
  locale: z.string().default('es-ES'),
  brand: z.string().optional(),
  author: z.string().optional(),
  byline: z.string().optional(),
  audienceName: z.string().optional(),
  audienceAge: z.number().optional(),
  wordCount: z.number(),
  sentenceCount: z.number(),
  estimatedDurationMin: z.number(),
  /** ISO8601 timestamp of when the content was generated; used as RSS pubDate. */
  generatedAt: z.string().optional(),
}).passthrough();

const CanonicalStorySchema = z.object({
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
  summary: z.string().optional(),
  vocabulary: z.array(z.string()).optional(),
  mood: MoodSchema,
  beats: z.array(BeatSchema).optional(),
  meta: CanonicalMetaSchema,
});

/**
 * Canonical input contract for any MP3-first source. The parser also accepts the
 * legacy Spanish aliases (`titulo`, `contenido`, `vocabularioNuevo`,
 * `meta.name`, `meta.age`) and normalizes them to the generic fields above.
 */
export const StorySchema = z.preprocess(normalizeStoryInput, CanonicalStorySchema);
export type Story = z.infer<typeof StorySchema>;

export const PlatformSchema = z.enum(['x', 'tiktok', 'instagram', 'youtube', 'spotify']);
export type Platform = z.infer<typeof PlatformSchema>;

/** Word-level transcript entry. Shared across subtitles, slide video, and publishers. */
export interface WordEntry {
  text: string;
  start: number;
  end: number;
}

export type PresetName = 'x' | 'tiktok' | 'reel' | 'youtube';

export interface VariantSpec {
  preset: PresetName;
  aspect: '1:1' | '9:16' | '16:9';
  width: number;
  height: number;
  maxDurationSec: number;
  clipSelectionMs?: { start: number; duration: number } | 'full';
}

/**
 * Per-platform canvas + duration limits that match what each platform actually accepts.
 * X=4h (Premium), TikTok=10min, Instagram Reels=3min, YouTube=effectively unlimited.
 * Splitting long content into multi-part posts (IG) lives in the publisher layer.
 * These values describe the platform ceiling, not our preferred clip length.
 */
export const VARIANTS: Record<Platform, VariantSpec | null> = {
  x:        { preset: 'x',       aspect: '1:1',  width: 1080, height: 1080, maxDurationSec: 14400,                 clipSelectionMs: 'full' },
  tiktok:   { preset: 'tiktok',  aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 600,                   clipSelectionMs: 'full' },
  instagram:{ preset: 'reel',    aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 180,                   clipSelectionMs: 'full' },
  youtube:  { preset: 'youtube', aspect: '16:9', width: 1920, height: 1080, maxDurationSec: Number.MAX_SAFE_INTEGER, clipSelectionMs: 'full' },
  spotify:  null,
};

export interface StoryAssets {
  slug: string;
  audioMp3Path: string;
  coverPngPath: string;
  metadata: Story;
}

export type CaptionStatus = 'ok' | 'skipped' | 'failed';

export interface PublishResult {
  platform: Platform;
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
  timestamp: string;
  /** If true, the platform was skipped (already published, or --dry-run short-circuit). */
  skipped?: boolean;
  /** Short machine-readable reason (e.g. "already published today"). */
  reason?: string;
  /** 1-based part index when a single publish is split across multiple parts (IG multi-part). */
  partIndex?: number;
  /** Total parts in this multi-part publish. */
  partTotal?: number;
  /** Status of the word-level transcript used to render captions. */
  captionStatus?: CaptionStatus;
  /** Non-fatal warnings surfaced during this publish (mood fallback, moderation, etc.). */
  warnings?: string[];
  /** For multi-part publishes (e.g. IG Reels split): one sub-result per part. The
   *  top-level success is true iff every part succeeded. */
  parts?: PublishResult[];
}

export interface DecisionLogEntry {
  id: string;
  action: string;
  contentSlug: string;
  /** Legacy field from pre-generic logs. New entries use contentSlug. */
  storySlug?: string;
  platform: Platform;
  reason: string;
  result: PublishResult;
  createdAt: string;
}

function normalizeStoryInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const rawMeta = isRecord(raw.meta) ? raw.meta : {};

  const title = firstString(raw.title, raw.titulo);
  const content = firstString(raw.content, raw.contenido, raw.description);
  const mood = firstString(raw.mood, rawMeta.mood) ?? 'fantasia';
  const vocabulary = Array.isArray(raw.vocabulary)
    ? raw.vocabulary
    : Array.isArray(raw.vocabularioNuevo)
      ? raw.vocabularioNuevo
      : undefined;

  const wordCount = firstNumber(rawMeta.wordCount) ?? countWords(content);
  const sentenceCount = firstNumber(rawMeta.sentenceCount) ?? countSentences(content);
  const estimatedDurationMin = firstNumber(rawMeta.estimatedDurationMin)
    ?? Math.max(1, Math.round(wordCount / 150));

  const audienceName = firstString(rawMeta.audienceName, rawMeta.name);
  const audienceAge = firstNumber(rawMeta.audienceAge, rawMeta.age);
  const brand = firstString(rawMeta.brand, raw.brand);
  const author = firstString(rawMeta.author, raw.author);
  const byline = firstString(rawMeta.byline, raw.byline);
  const slug = firstString(rawMeta.slug, raw.slug);

  return {
    ...raw,
    title,
    content,
    vocabulary,
    mood,
    meta: {
      ...rawMeta,
      slug,
      mood,
      brand,
      author,
      byline,
      audienceName,
      audienceAge,
      wordCount,
      sentenceCount,
      estimatedDurationMin,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function countWords(text: string | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string | undefined): number {
  if (!text) return 0;
  const matches = text.match(/[.!?…]+(?=\s|$)/gu);
  return Math.max(1, matches?.length ?? 0);
}
