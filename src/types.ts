import { z } from 'zod';

export const MoodSchema = z.enum([
  'aventura', 'calma', 'comedia', 'misterio',
  'emocionante', 'fantasia', 'naturaleza',
]);
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

export const StorySchema = z.object({
  titulo: z.string(),
  contenido: z.string(),
  vocabularioNuevo: z.array(z.string()).optional(),
  mood: MoodSchema,
  beats: z.array(BeatSchema).optional(),
  meta: z.object({
    slug: z.string(),
    age: z.number(),
    mood: MoodSchema,
    locale: z.string(),
    name: z.string(),
    nivel: z.number(),
    model: z.string(),
    wordCount: z.number(),
    sentenceCount: z.number(),
    estimatedDurationMin: z.number(),
    /** ISO8601 timestamp of when the story was generated; used as RSS pubDate. */
    generatedAt: z.string().optional(),
  }).passthrough(),
});
export type Story = z.infer<typeof StorySchema>;

/**
 * StorySchemaV2: the AudioKids output format introduced in 2026-04 onwards.
 * Each story is a directory `<outputDir>/<slug>/` containing `story.json`
 * (matching this schema), `<slug>.mp3`, and `chunks/`. Notable shape changes
 * vs. v1 (StorySchema):
 *   - top-level slug
 *   - `job` block carries the recipient + generation params (childName, age,
 *     locale, mood, targetDurationMin, ...)
 *   - `story.{title,content,vocabulary,beats,chapters,assessmentQuestions}`
 *     replaces the old top-level titulo/contenido/vocabularioNuevo + meta.*
 *
 * Schema is intentionally permissive (`.passthrough()` and string mood) because
 * AudioKids is an upstream we don't control; we want adapter parsing to keep
 * working when AudioKids adds fields. The audiokids adapter is the only place
 * that maps this schema to the neutral ContentBundle.
 */
export const StoryV2JobSchema = z.object({
  childName: z.string().nullable().optional(),
  childAge: z.number().nullable().optional(),
  childGender: z.string().nullable().optional(),
  locale: z.string(),
  mood: z.string(),
  genre: z.string().optional(),
  targetDurationMin: z.number().optional(),
  targetDepthLevel: z.number().optional(),
  storyId: z.string().optional(),
  ttsProvider: z.string().optional(),
  childInterests: z.array(z.string()).optional(),
  hobbies: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  homeCity: z.string().nullable().optional(),
}).passthrough();

export const StoryV2BeatSchema = z.object({
  t_ms: z.number(),
  type: z.string(),
  leitmotif: z.string().optional(),
  ambience: z.string().optional(),
  intensity: z.enum(['low', 'mid', 'high']).optional(),
  anchorWord: z.string().optional(),
  delivery: z.object({
    style: z.string().optional(),
    pace: z.string().optional(),
    emotion: z.string().optional(),
  }).passthrough().optional(),
  sceneTags: z.array(z.string()).optional(),
  sfx: z.array(z.object({
    id: z.string(),
    anchorWord: z.string().optional(),
    tier: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const StorySchemaV2 = z.object({
  slug: z.string(),
  job: StoryV2JobSchema,
  story: z.object({
    title: z.string(),
    content: z.string(),
    vocabulary: z.array(z.string()).optional(),
    beats: z.array(StoryV2BeatSchema).optional(),
    chapters: z.array(z.unknown()).optional(),
    assessmentQuestions: z.array(z.unknown()).optional(),
    usage: z.record(z.unknown()).optional(),
  }).passthrough(),
}).passthrough();
export type StoryV2 = z.infer<typeof StorySchemaV2>;

export const PlatformSchema = z.enum(['x', 'tiktok', 'instagram', 'youtube', 'spotify']);
export type Platform = z.infer<typeof PlatformSchema>;

/** Word-level transcript entry. Shared across subtitles, slide video, and publishers. */
export interface WordEntry {
  text: string;
  start: number;
  end: number;
  /** Per-word confidence in [0,1] as reported by whisper. Undefined when unknown. */
  confidence?: number;
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
 * Splitting long cuentos into multi-part posts (IG) lives in the publisher layer,
 * not here: these values describe the platform ceiling, not our preferred clip length.
 */
export const VARIANTS: Record<Platform, VariantSpec | null> = {
  x:        { preset: 'x',       aspect: '1:1',  width: 1080, height: 1080, maxDurationSec: 14400,                 clipSelectionMs: 'full' },
  tiktok:   { preset: 'tiktok',  aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 600,                   clipSelectionMs: 'full' },
  instagram:{ preset: 'reel',    aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 180,                   clipSelectionMs: 'full' },
  youtube:  { preset: 'youtube', aspect: '16:9', width: 1920, height: 1080, maxDurationSec: Number.MAX_SAFE_INTEGER, clipSelectionMs: 'full' },
  spotify:  null,
};

export type CaptionStatus = 'ok' | 'skipped' | 'failed';

/** Kept in sync with src/core/errors.ts ErrorKind. Duplicated here to avoid a core→types loop. */
export type ErrorClassName = 'transient' | 'permanent' | 'needs-config' | 'needs-human' | 'unknown';

export interface PublishResult {
  platform: Platform;
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
  /** Classified error kind when success=false. Drives retry/backoff/dispatch gating. */
  errorClass?: ErrorClassName;
  /** Machine-readable remediation hint attached by the error classifier. */
  remediation?: { action: string; humanHint: string; args?: Record<string, unknown> };
  /** Id of the CTA variant used in the caption. Set when D.2 rotator picked one. */
  ctaVariant?: string;
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
  storySlug: string;
  platform: Platform;
  reason: string;
  result: PublishResult;
  createdAt: string;
  /** Correlates every entry emitted by the same Orchestrator.publish() call. Optional
   *  because historical entries predate the field; consumers treat its absence as
   *  "unknown run" and do not group. */
  runId?: string;
}
