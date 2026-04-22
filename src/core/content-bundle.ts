import { z } from 'zod';
import { BeatSchema } from '../types.js';

/**
 * ContentBundle is the neutral contract that every pipeline produces and every tool
 * consumes. Pipelines (AudioKids, custom, etc.) map their native shape into this
 * via an adapter (src/adapters/*). Tools (transcribe, render-editorial,
 * caption-build, publish-*) read ONLY from ContentBundle, never from pipeline-specific
 * shapes. That's the whole point: decouple PostizAgent from AudioKids.
 */

export const RecipientShareConsentSchema = z.enum(['public', 'first-name-only', 'anonymous']);
export type RecipientShareConsent = z.infer<typeof RecipientShareConsentSchema>;

export const RecipientSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0).max(120).optional(),
  interests: z.array(z.string()).optional(),
  relationship: z.string().optional(),
  shareConsent: RecipientShareConsentSchema,
});
export type Recipient = z.infer<typeof RecipientSchema>;

export const ThemeHintsSchema = z.object({
  treatment: z.string().optional(),
  paletteId: z.string().optional(),
  fontPairingId: z.string().optional(),
  mood: z.string().optional(),
  keywords: z.array(z.string()).optional(),
}).strict();
export type ThemeHints = z.infer<typeof ThemeHintsSchema>;

export const ContentBundleKindSchema = z.enum(['audio-story', 'video', 'image-post', 'text']);
export type ContentBundleKind = z.infer<typeof ContentBundleKindSchema>;

export const ContentBundleSchema = z.object({
  /** Stable unique id used for idempotency, decision log, theme cache. */
  id: z.string().min(1),

  /** Content kind drives which tools are applicable (only audio-story needs transcribe, etc.). */
  kind: ContentBundleKindSchema,

  /** Primary asset: mp3 for audio-story, mp4 for video, png for image-post. Optional for text. */
  primaryMedia: z.string().optional(),

  /** Cover/thumbnail path. */
  cover: z.string().optional(),

  /** Text payload. body is always required; title and tagline optional. */
  text: z.object({
    title: z.string().optional(),
    body: z.string(),
    tagline: z.string().optional(),
  }),

  /** ISO 639-1 ("es") or BCP 47 ("es-ES"). Drives whisper language and caption tone. */
  locale: z.string().min(2),

  /** Optional visual theme hints. If absent, the theme engine derives them. */
  theme: ThemeHintsSchema.optional(),

  /** Optional recipient info for contextual captions. */
  recipient: RecipientSchema.optional(),

  /** Optional musical/narrative beats, used for multi-part splitting. */
  beats: z.array(BeatSchema).optional(),

  /**
   * Pipeline-specific passthrough metadata. Tools SHOULD NOT read directly from here;
   * adapters must map relevant fields into typed ContentBundle fields. Exists as an
   * escape hatch during migration.
   */
  sourceMeta: z.record(z.unknown()).optional(),
}).strict();

export type ContentBundle = z.infer<typeof ContentBundleSchema>;

/** Return the tagline a publisher/renderer should show. Derives from recipient if consent allows. */
export function resolveTagline(bundle: ContentBundle): string | undefined {
  if (bundle.text.tagline) return bundle.text.tagline;
  const r = bundle.recipient;
  if (!r) return undefined;
  if (r.shareConsent === 'anonymous') {
    return r.age != null ? `para un niño de ${r.age} años` : undefined;
  }
  const first = r.name.split(/\s+/)[0];
  return r.age != null ? `${first} · ${r.age} años` : first;
}
