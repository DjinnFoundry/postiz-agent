import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../config.js';
import {
  ThemeCatalogSchema,
  type Palette,
  type FontPairing,
  type Treatment,
} from './types.js';

const DEFAULT_PALETTES_PATH   = resolve(config.paths.projectRoot, 'hyperframes', 'themes', 'palettes.json');
const DEFAULT_FONTS_PATH      = resolve(config.paths.projectRoot, 'hyperframes', 'themes', 'fonts.json');
const DEFAULT_TREATMENTS_PATH = resolve(config.paths.projectRoot, 'hyperframes', 'themes', 'treatments.json');
/** Where cached theme decisions live. Keyed by bundle.id, never expires (a bundle's look should be stable). */
const DECISIONS_PATH = resolve(config.paths.projectRoot, 'data', 'theme-decisions.json');

export interface ThemeCatalog {
  palettes: Palette[];
  pairings: FontPairing[];
  treatments: Treatment[];
  moodCandidates: Record<string, string[]>;
  keywordHints: Record<string, string[]>;
  fallback: string;
  catalogVersion: string;
}

export type ThemeDecisionStaleReason =
  | 'version-mismatch'
  | 'unknown-treatment-id'
  | 'legacy-no-version';

export interface ThemeDecision {
  bundleId: string;
  treatmentId: string;
  paletteId?: string;
  fontPairingId?: string;
  source: 'explicit' | 'agent' | 'mood' | 'keywords' | 'fallback';
  decidedAt: string;
  decidedBy?: string;
  catalogVersion?: string;
}

export interface StaleDecisionEntry {
  bundleId: string;
  decision: ThemeDecision;
  reason: ThemeDecisionStaleReason;
}

export function loadCatalog(paths?: {
  palettes?: string; fonts?: string; treatments?: string;
}): ThemeCatalog {
  const palettesRaw = JSON.parse(readFileSync(paths?.palettes ?? DEFAULT_PALETTES_PATH, 'utf-8'));
  const fontsRaw = JSON.parse(readFileSync(paths?.fonts ?? DEFAULT_FONTS_PATH, 'utf-8'));
  const treatmentsRaw = JSON.parse(readFileSync(paths?.treatments ?? DEFAULT_TREATMENTS_PATH, 'utf-8'));

  ThemeCatalogSchema.parse(palettesRaw);
  ThemeCatalogSchema.parse(fontsRaw);
  ThemeCatalogSchema.parse(treatmentsRaw);

  const catalogVersion = `${treatmentsRaw.version}:${palettesRaw.version}:${fontsRaw.version}`;

  return {
    palettes: palettesRaw.palettes as Palette[],
    pairings: fontsRaw.pairings as FontPairing[],
    treatments: treatmentsRaw.treatments as Treatment[],
    moodCandidates: treatmentsRaw.moodCandidates ?? {},
    keywordHints: treatmentsRaw.keywordHints ?? {},
    fallback: treatmentsRaw.fallback ?? 'hero-display',
    catalogVersion,
  };
}

/**
 * Persistent decision cache: once a bundle resolves to a theme, that choice is
 * written to data/theme-decisions.json and reused for every future render.
 * Each decision is stamped with the catalogVersion at write-time so that a
 * bump to any of treatments.json / palettes.json / fonts.json invalidates the
 * cache (the resolver re-resolves on next publish).
 */
export class ThemeDecisionStore {
  constructor(private readonly path: string = DECISIONS_PATH) {}

  get(bundleId: string): ThemeDecision | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const file = JSON.parse(readFileSync(this.path, 'utf-8')) as { decisions?: Record<string, ThemeDecision> };
      return file.decisions?.[bundleId];
    } catch {
      return undefined;
    }
  }

  set(decision: ThemeDecision, opts: { catalogVersion?: string } = {}): void {
    const current = this.readAll();
    const stamped: ThemeDecision = opts.catalogVersion
      ? { ...decision, catalogVersion: opts.catalogVersion }
      : decision;
    current[stamped.bundleId] = stamped;
    this.writeAll(current);
  }

  all(): Record<string, ThemeDecision> {
    return this.readAll();
  }

  clear(bundleId: string): void {
    const current = this.readAll();
    if (!(bundleId in current)) return;
    delete current[bundleId];
    this.writeAll(current);
  }

  listStale(catalog: ThemeCatalog): StaleDecisionEntry[] {
    const known = new Set(catalog.treatments.map(t => t.id));
    const out: StaleDecisionEntry[] = [];
    for (const [bundleId, decision] of Object.entries(this.readAll())) {
      if (!known.has(decision.treatmentId)) {
        out.push({ bundleId, decision, reason: 'unknown-treatment-id' });
        continue;
      }
      if (decision.catalogVersion === undefined) {
        out.push({ bundleId, decision, reason: 'legacy-no-version' });
        continue;
      }
      if (decision.catalogVersion !== catalog.catalogVersion) {
        out.push({ bundleId, decision, reason: 'version-mismatch' });
      }
    }
    return out;
  }

  clearStale(catalog: ThemeCatalog): StaleDecisionEntry[] {
    const stale = this.listStale(catalog);
    if (stale.length === 0) return [];
    const current = this.readAll();
    for (const s of stale) delete current[s.bundleId];
    this.writeAll(current);
    return stale;
  }

  /** Lightweight digest used by doctor/status. exists distinguishes "fresh tenant"
   *  (no file yet, count=0 is fine) from "file unreadable" (would still report 0). */
  summarize(): { count: number; exists: boolean } {
    if (!existsSync(this.path)) return { count: 0, exists: false };
    return { count: Object.keys(this.readAll()).length, exists: true };
  }

  private readAll(): Record<string, ThemeDecision> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { decisions?: Record<string, ThemeDecision> };
      return raw.decisions ?? {};
    } catch {
      return {};
    }
  }

  private writeAll(decisions: Record<string, ThemeDecision>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, decisions }, null, 2));
  }
}
