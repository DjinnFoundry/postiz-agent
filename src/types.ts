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
    generatedAt: z.string().optional(),
  }).passthrough(),
});
export type Story = z.infer<typeof StorySchema>;

export const PlatformSchema = z.enum(['x', 'tiktok', 'instagram', 'youtube', 'spotify']);
export type Platform = z.infer<typeof PlatformSchema>;

export type PresetName = 'x' | 'tiktok' | 'reel' | 'youtube';

export interface VariantSpec {
  preset: PresetName;
  aspect: '1:1' | '9:16' | '16:9';
  width: number;
  height: number;
  maxDurationSec: number;
  clipSelectionMs?: { start: number; duration: number } | 'full';
}

export const VARIANTS: Record<Platform, VariantSpec | null> = {
  x:        { preset: 'x',       aspect: '1:1',  width: 1080, height: 1080, maxDurationSec: 120, clipSelectionMs: 'full' },
  tiktok:   { preset: 'tiktok',  aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 60  },
  instagram:{ preset: 'reel',    aspect: '9:16', width: 1080, height: 1920, maxDurationSec: 90  },
  youtube:  { preset: 'youtube', aspect: '16:9', width: 1920, height: 1080, maxDurationSec: 3600, clipSelectionMs: 'full' },
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
  storySlug: string;
  platform: Platform;
  reason: string;
  result: PublishResult;
  createdAt: string;
}
