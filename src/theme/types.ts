import { z } from 'zod';

export const PaletteSchema = z.object({
  id: z.string(),
  bg: z.string(),
  ink: z.string(),
  accent: z.string(),
  muted: z.string(),
  highlight: z.string(),
}).strict();
export type Palette = z.infer<typeof PaletteSchema>;

export const FontFaceSchema = z.object({
  family: z.string(),
  weights: z.array(z.number()),
  url: z.string(),
}).strict();
export type FontFace = z.infer<typeof FontFaceSchema>;

export const FontPairingSchema = z.object({
  id: z.string(),
  display: FontFaceSchema,
  body: FontFaceSchema,
  folio: FontFaceSchema.optional(),
}).strict();
export type FontPairing = z.infer<typeof FontPairingSchema>;

export const TreatmentFamilySchema = z.enum(['editorial', 'infantil', 'epica', 'tech']);
export type TreatmentFamily = z.infer<typeof TreatmentFamilySchema>;

export const TreatmentSchema = z.object({
  id: z.string(),
  family: TreatmentFamilySchema,
  palettes: z.array(z.string()).min(1),
  fontPairing: z.string(),
  layoutHints: z.record(z.unknown()).optional(),
  description: z.string(),
}).strict();
export type Treatment = z.infer<typeof TreatmentSchema>;

export const ThemeCatalogSchema = z.object({
  version: z.literal(1),
  palettes: z.array(PaletteSchema).optional(),
  pairings: z.array(FontPairingSchema).optional(),
  treatments: z.array(TreatmentSchema).optional(),
  moodCandidates: z.record(z.array(z.string())).optional(),
  keywordHints: z.record(z.array(z.string())).optional(),
  fallback: z.string().optional(),
}).strict();

export interface ResolvedTheme {
  treatment: Treatment;
  palette: Palette;
  fontPairing: FontPairing;
  /** Where the resolver pulled this from: 'explicit' | 'agent' | 'mood' | 'keywords' | 'fallback'. */
  source: ResolvedThemeSource;
}

export type ResolvedThemeSource = 'explicit' | 'agent' | 'mood' | 'keywords' | 'fallback';
