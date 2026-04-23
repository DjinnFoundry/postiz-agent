import type { ContentBundle, Recipient, RecipientShareConsent } from '../core/content-bundle.js';
import type { Platform } from '../types.js';
import { selectCta, type CtaVariant } from './ctas.js';
import { deriveHashtags, primaryLocale } from './hashtags.js';

/**
 * Builds the social caption for every platform from a ContentBundle. Pure:
 * same bundle + same platform + same variant → identical output. Handles
 * share-consent rules (public | first-name-only | anonymous) and platform-specific
 * length caps (TikTok: tight, X: 280, Instagram: 2200, YouTube: up to 5000).
 *
 * Callers can pass `part?` for Instagram multi-part publishes so "Parte i de N"
 * is appended; and `cta` / `teaser` as overrides when the caller has already
 * resolved them via the CTA rotator or teaser extractor (D.2). When those are
 * omitted we fall back to a generic closing line and a body-derived teaser.
 */

export interface CaptionBuildOptions {
  bundle: ContentBundle;
  platform: Platform;
  /** 1-based part index for IG multi-part publishes. */
  part?: { index: number; total: number };
  /** Pre-resolved CTA text (from D.2 rotator). If omitted a generic line is used. */
  cta?: string;
  /** Pre-extracted teaser (from D.2). Overrides the auto-extract path. */
  teaser?: string;
  /** Override the hashtag set. Default derives from mood + content. */
  hashtags?: string[];
}

/** Hard caps on the final caption length per platform, with some slack. */
const LENGTH_CAP: Record<Platform, number> = {
  x:         280,
  tiktok:    2200,
  instagram: 2200,
  youtube:   5000,
  spotify:   0,
};

export interface CaptionBuildResult {
  caption: string;
  ctaVariantId: string | null;
  teaser: string;
  hashtags: string[];
}

export function buildCaption(opts: CaptionBuildOptions): string {
  return buildCaptionRich(opts).caption;
}

/**
 * Rich variant that also reports which CTA variant was selected, the teaser it
 * ended up using, and the hashtag set. Used by publishers that want to log the
 * ctaVariant into the decision log for analytics.
 */
export function buildCaptionRich(opts: CaptionBuildOptions): CaptionBuildResult {
  const { bundle, platform } = opts;
  const tagline = taglineForRecipient(bundle.recipient);
  const hashtags = opts.hashtags ?? deriveHashtags(bundle);
  let ctaVariant: CtaVariant | null = null;
  let ctaText: string;
  if (opts.cta != null) {
    ctaText = opts.cta.trim();
  } else {
    ctaVariant = selectCta(platform, bundle.id, primaryLocale(bundle.locale));
    ctaText = (ctaVariant?.text ?? '').trim();
  }
  const partSuffix = opts.part ? ` · Parte ${opts.part.index} de ${opts.part.total}` : '';
  const title = redactName(bundle.text.title ?? bundle.id, bundle.recipient).trim();
  const rawTeaser = opts.teaser ?? extractTeaser(bundle.text.body);
  const teaser = redactName(rawTeaser, bundle.recipient).trim();

  let out: string;
  switch (platform) {
    case 'instagram': out = buildInstagram({ title, tagline, teaser, cta: ctaText, hashtags, partSuffix }); break;
    case 'tiktok':    out = buildTikTok({ title, tagline, cta: ctaText, hashtags, partSuffix });            break;
    case 'x':         out = buildX({ title, tagline, cta: ctaText, hashtags, partSuffix });                 break;
    case 'youtube':   out = buildYoutube({ bundle, title, tagline, cta: ctaText, hashtags });               break;
    case 'spotify':   out = '';                                                                             break;
  }
  return {
    caption: enforceLength(out, LENGTH_CAP[platform]),
    ctaVariantId: ctaVariant?.id ?? null,
    teaser,
    hashtags,
  };
}

/** Convenience: render every platform at once. Useful for CLI preview. */
export function buildAllCaptions(bundle: ContentBundle, opts: Partial<CaptionBuildOptions> = {}): Record<Platform, string> {
  const out: Partial<Record<Platform, string>> = {};
  for (const p of ['x', 'tiktok', 'instagram', 'youtube', 'spotify'] as Platform[]) {
    out[p] = buildCaption({ bundle, platform: p, ...opts });
  }
  return out as Record<Platform, string>;
}

// ─── Platform builders ───────────────────────────────────────────────────

interface CommonFields {
  title: string;
  tagline: string | null;
  cta: string;
  hashtags: string[];
  partSuffix: string;
}

function buildInstagram(f: CommonFields & { teaser: string }): string {
  const dedication = f.tagline ? `Un audiocuento a medida para ${f.tagline}.` : 'Un audiocuento hecho a medida.';
  const lines = [
    `🎧 "${f.title}"${f.partSuffix}`,
    dedication,
    f.teaser ? '' : undefined,
    f.teaser || undefined,
    f.cta ? '' : undefined,
    f.cta || undefined,
    '',
    f.hashtags.map(h => `#${h}`).join(' '),
  ].filter((l): l is string => l !== undefined);
  return lines.join('\n');
}

function buildTikTok(f: CommonFields): string {
  const dedication = f.tagline ? `Para ${f.tagline}` : 'Hecho a medida';
  const parts = [
    `"${f.title}"${f.partSuffix}`,
    dedication,
    f.cta,
  ].filter(Boolean);
  const hashtagLine = f.hashtags.slice(0, 4).map(h => `#${h}`).join(' ');
  return `${parts.join(' · ')} 🎧 ${hashtagLine}`;
}

function buildX(f: CommonFields): string {
  const dedication = f.tagline ? ` · para ${f.tagline}` : '';
  const hashtagLine = f.hashtags.slice(0, 2).map(h => `#${h}`).join(' ');
  const base = `"${f.title}"${f.partSuffix}${dedication}`;
  // Greedy trim: keep title, add cta only if it still fits.
  const withCta = `${base} · ${f.cta} ${hashtagLine}`.trim();
  if (withCta.length <= LENGTH_CAP.x) return withCta;
  const withoutCta = `${base} ${hashtagLine}`.trim();
  return withoutCta;
}

function buildYoutube(f: { bundle: ContentBundle; title: string; tagline: string | null; cta: string; hashtags: string[] }): string {
  const title = f.title;
  const teaser = redactName(extractTeaser(f.bundle.text.body, { maxChars: 500 }), f.bundle.recipient);
  const mood = f.bundle.theme?.mood ?? 'cuento';
  const forWhom = f.tagline ? `para ${f.tagline}` : 'hecho a medida';
  const duration = (f.bundle.sourceMeta?.estimatedDurationMin as number | undefined);
  const durationLine = duration != null ? ` · Duración: ~${duration} min` : '';
  const vocab = Array.isArray(f.bundle.sourceMeta?.vocabularioNuevo) && (f.bundle.sourceMeta!.vocabularioNuevo as unknown[]).length
    ? `\nVocabulario nuevo: ${(f.bundle.sourceMeta!.vocabularioNuevo as string[]).join(', ')}`
    : '';
  const hashtagLine = f.hashtags.map(h => `#${h}`).join(' ');
  return [
    `"${title}"`,
    '',
    teaser,
    '',
    `Un audiocuento de AudioKids ${forWhom}.`,
    `Género: ${mood}${durationLine}${vocab}`,
    '',
    f.cta,
    '',
    hashtagLine,
  ].filter(Boolean).join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Scrub every token of the recipient's name out of arbitrary text when consent
 * is 'anonymous'. `public` and `first-name-only` leave the text untouched
 * (those consents accept the name appearing verbatim; the tagline layer is
 * where `first-name-only` drops surnames for rendering).
 *
 * Matching uses Unicode-aware boundaries via lookarounds over `\p{L}\p{M}\p{N}_`
 * so accented letters (`García`, `María`) are treated as part of the same word.
 * ASCII `\b` in JS does not include accented chars as word characters, which
 * would let `\bGarcía\b` leak when followed by a space.
 *
 * We intentionally do NOT cover diminutives or morphological variants
 * (Marcos/Marquitos, Ana/Anita). That would need a stemmer / a curated alias
 * list and belongs in a future pass; for now, if the source text introduces
 * variants the recipient record did not list, they pass through.
 */
function redactName(text: string, recipient?: Recipient): string {
  if (!text || !recipient || recipient.shareConsent !== 'anonymous') return text;
  const tokens = recipient.name.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return text;
  let out = text;
  for (const tok of tokens) {
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegex(tok)}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu');
    out = out.replace(re, '…');
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function taglineForRecipient(recipient?: Recipient): string | null {
  if (!recipient) return null;
  const consent: RecipientShareConsent = recipient.shareConsent;
  if (consent === 'anonymous') {
    return recipient.age != null ? `un niño de ${recipient.age} años` : 'un niño';
  }
  const first = recipient.name.trim().split(/\s+/)[0];
  if (!first) return null;
  const interests = recipient.interests?.slice(0, 2).filter(Boolean);
  const interestStr = interests && interests.length
    ? ` que ${interests.length === 1 ? 'adora los ' + interests[0] : 'adora los ' + interests.join(' y los ')}`
    : '';
  if (recipient.age != null) {
    return `${first}, ${recipient.age} años${interestStr}`;
  }
  return `${first}${interestStr}`;
}

/**
 * Extract a teaser from the body: first 1-2 full sentences, capped at `maxChars`.
 * Never mid-word, never mid-sentence-end. Falls back to a hard cut on word
 * boundary when the content has no sentence terminators.
 */
export function extractTeaser(body: string, opts: { maxChars?: number } = {}): string {
  const cap = opts.maxChars ?? 180;
  if (!body) return '';
  // Pick up to 2 sentences.
  const sentences: string[] = [];
  const re = /[^.!?…]+[.!?…]+/g;
  let match: RegExpExecArray | null;
  let total = 0;
  while ((match = re.exec(body)) !== null && sentences.length < 2) {
    const s = match[0].trim();
    if (total + s.length > cap) break;
    sentences.push(s);
    total += s.length + 1;
  }
  if (sentences.length) return sentences.join(' ');
  // No sentence terminators; hard-cut on word boundary.
  const trimmed = body.trim();
  if (trimmed.length <= cap) return trimmed;
  const clipped = trimmed.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped) + '…';
}

function enforceLength(s: string, cap: number): string {
  if (!cap || s.length <= cap) return s;
  const clipped = s.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}
