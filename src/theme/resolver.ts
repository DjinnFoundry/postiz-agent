import { createHash } from 'node:crypto';
import type { ContentBundle } from '../core/content-bundle.js';
import { ThemeDecisionStore, loadCatalog, type ThemeCatalog, type ThemeDecision } from './catalog.js';
import type { Palette, FontPairing, Treatment, ResolvedTheme, ResolvedThemeSource } from './types.js';

export interface ResolveOptions {
  catalog?: ThemeCatalog;
  store?: ThemeDecisionStore;
  /** When true (default), cache the resolved decision so future renders are identical. */
  persist?: boolean;
  /** Override the current timestamp (testing). */
  now?: () => Date;
}

/**
 * Resolve a ContentBundle to a concrete treatment + palette + font pairing.
 *
 * Priority order, first match wins:
 *  1. Persisted decision for this bundle.id (once an agent or prior call picked a
 *     theme, that choice is locked — reproducibility across runs).
 *  2. Explicit bundle.theme.treatment (the agent/pipeline declared one upstream).
 *  3. keyword hints from bundle.text body (e.g. "dragón" → medieval).
 *  4. mood candidates for bundle.theme.mood, seeded by hash(bundle.id).
 *  5. catalog.fallback.
 *
 * Deterministic everywhere: hash(bundle.id) chooses within a candidate list, so
 * the same bundle always produces the same look regardless of which machine
 * renders it.
 */
export function resolveTheme(bundle: ContentBundle, opts: ResolveOptions = {}): ResolvedTheme {
  const catalog = opts.catalog ?? loadCatalog();
  const store = opts.store ?? new ThemeDecisionStore();
  const persist = opts.persist ?? true;
  const now = opts.now ?? (() => new Date());

  const byTreatment = new Map(catalog.treatments.map(t => [t.id, t]));
  const byPalette = new Map(catalog.palettes.map(p => [p.id, p]));
  const byPairing = new Map(catalog.pairings.map(f => [f.id, f]));

  // 1. Persisted decision
  const prior = store.get(bundle.id);
  if (prior && byTreatment.has(prior.treatmentId)) {
    return materialize(prior, byTreatment, byPalette, byPairing, catalog, bundle);
  }

  // 2. Explicit hints from the bundle itself
  if (bundle.theme?.treatment && byTreatment.has(bundle.theme.treatment)) {
    const decision: ThemeDecision = {
      bundleId: bundle.id,
      treatmentId: bundle.theme.treatment,
      paletteId: bundle.theme.paletteId,
      fontPairingId: bundle.theme.fontPairingId,
      source: 'explicit',
      decidedAt: now().toISOString(),
    };
    if (persist) store.set(decision);
    return materialize(decision, byTreatment, byPalette, byPairing, catalog, bundle);
  }

  // 3. Keyword hints from body text
  const keywordMatch = matchKeywords(bundle, catalog);
  if (keywordMatch) {
    const treatmentId = pickFromCandidates(keywordMatch, bundle.id, byTreatment, catalog.fallback);
    const decision: ThemeDecision = {
      bundleId: bundle.id, treatmentId, source: 'keywords', decidedAt: now().toISOString(),
    };
    if (persist) store.set(decision);
    return materialize(decision, byTreatment, byPalette, byPairing, catalog, bundle);
  }

  // 4. Mood candidates
  const mood = bundle.theme?.mood;
  if (mood && catalog.moodCandidates[mood]) {
    const treatmentId = pickFromCandidates(catalog.moodCandidates[mood], bundle.id, byTreatment, catalog.fallback);
    const decision: ThemeDecision = {
      bundleId: bundle.id, treatmentId, source: 'mood', decidedAt: now().toISOString(),
    };
    if (persist) store.set(decision);
    return materialize(decision, byTreatment, byPalette, byPairing, catalog, bundle);
  }

  // 5. Fallback
  const decision: ThemeDecision = {
    bundleId: bundle.id, treatmentId: catalog.fallback, source: 'fallback', decidedAt: now().toISOString(),
  };
  if (persist) store.set(decision);
  return materialize(decision, byTreatment, byPalette, byPairing, catalog, bundle);
}

/** Inspect body text for catalog keyword hints; returns a candidate list or null.
 *  Tokenises the body and title on non-letter boundaries so a keyword like "mar"
 *  does NOT spuriously match inside "Marcos" or "armario". Plurals and morphological
 *  variants should be added explicitly to keywordHints if we want them. */
function matchKeywords(bundle: ContentBundle, catalog: ThemeCatalog): string[] | null {
  if (!catalog.keywordHints || Object.keys(catalog.keywordHints).length === 0) return null;
  const text = normalize(bundle.text.body + ' ' + (bundle.text.title ?? ''));
  const tokens = new Set(text.split(/[^a-z0-9]+/u).filter(Boolean));
  const hits: string[] = [];
  for (const [keyword, candidates] of Object.entries(catalog.keywordHints)) {
    if (tokens.has(normalize(keyword))) hits.push(...candidates);
  }
  const seen = new Set<string>();
  const ordered = hits.filter(h => (seen.has(h) ? false : seen.add(h) && true));
  return ordered.length ? ordered : null;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function pickFromCandidates(
  candidates: string[],
  seed: string,
  byTreatment: Map<string, Treatment>,
  fallback: string,
): string {
  const valid = candidates.filter(c => byTreatment.has(c));
  if (valid.length === 0) return fallback;
  const h = hashToInt(seed);
  return valid[h % valid.length];
}

/** Turn a string id into a stable non-negative integer. SHA1 first 8 hex chars → int. */
function hashToInt(s: string): number {
  const hex = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

function materialize(
  decision: ThemeDecision,
  byTreatment: Map<string, Treatment>,
  byPalette: Map<string, Palette>,
  byPairing: Map<string, FontPairing>,
  catalog: ThemeCatalog,
  bundle: ContentBundle,
): ResolvedTheme {
  const treatment = byTreatment.get(decision.treatmentId) ?? byTreatment.get(catalog.fallback);
  if (!treatment) throw new Error(`treatment "${decision.treatmentId}" and fallback "${catalog.fallback}" both missing from catalog`);

  // Palette: explicit → hash-selected from treatment.palettes → first.
  const paletteId = decision.paletteId && byPalette.has(decision.paletteId)
    ? decision.paletteId
    : pickFromPaletteCandidates(treatment.palettes, bundle.id, byPalette);
  const palette = byPalette.get(paletteId) ?? catalog.palettes[0];

  // Fonts: pairing id comes from the treatment unless overridden in the decision.
  const pairingId = decision.fontPairingId && byPairing.has(decision.fontPairingId)
    ? decision.fontPairingId
    : treatment.fontPairing;
  const fontPairing = byPairing.get(pairingId) ?? catalog.pairings[0];

  return {
    treatment,
    palette,
    fontPairing,
    source: decision.source as ResolvedThemeSource,
  };
}

function pickFromPaletteCandidates(ids: string[], seed: string, byPalette: Map<string, Palette>): string {
  const valid = ids.filter(i => byPalette.has(i));
  if (valid.length === 0) return [...byPalette.keys()][0];
  const h = hashToInt(seed + ':palette');
  return valid[h % valid.length];
}
