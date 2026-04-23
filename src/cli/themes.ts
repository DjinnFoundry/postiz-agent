import {
  loadCatalog,
  ThemeDecisionStore,
  type StaleDecisionEntry,
  type ThemeCatalog,
  type ThemeDecisionStaleReason,
} from '../theme/catalog.js';
import type { FontPairing, Palette, Treatment } from '../theme/types.js';

export interface ThemeListRow {
  id: string;
  family: Treatment['family'];
  palettes: string[];
  paletteCount: number;
  fontPairing: string;
  description: string;
}

export interface ThemesListReport {
  generatedAt: string;
  fallback: string;
  treatments: ThemeListRow[];
}

export interface ThemeDescriptor {
  ok: true;
  treatment: Treatment;
  // Concrete palette objects (not just ids) so consumers can render swatches without a second lookup.
  palettes: Palette[];
  fontPairing: FontPairing;
}

export interface ThemeDescriptorError {
  ok: false;
  error: string;
  knownIds: string[];
}

export interface ThemesHelperOptions {
  catalog?: ThemeCatalog;
  now?: () => Date;
}

export function listThemes(opts: ThemesHelperOptions = {}): ThemesListReport {
  const catalog = opts.catalog ?? loadCatalog();
  const now = opts.now ?? (() => new Date());
  const treatments: ThemeListRow[] = catalog.treatments.map(t => ({
    id: t.id,
    family: t.family,
    palettes: [...t.palettes],
    paletteCount: t.palettes.length,
    fontPairing: t.fontPairing,
    description: t.description,
  }));
  return {
    generatedAt: now().toISOString(),
    fallback: catalog.fallback,
    treatments,
  };
}

export function describeTheme(
  id: string,
  opts: ThemesHelperOptions = {},
): ThemeDescriptor | ThemeDescriptorError {
  const catalog = opts.catalog ?? loadCatalog();
  const treatment = catalog.treatments.find(t => t.id === id);
  if (!treatment) {
    return {
      ok: false,
      error: `unknown treatment id: ${id}`,
      knownIds: catalog.treatments.map(t => t.id),
    };
  }
  const byPalette = new Map(catalog.palettes.map(p => [p.id, p]));
  // Skip ids the treatment references that are missing from the palette file (catalog drift).
  const palettes = treatment.palettes
    .map(pid => byPalette.get(pid))
    .filter((p): p is Palette => Boolean(p));
  const fontPairing = catalog.pairings.find(p => p.id === treatment.fontPairing);
  if (!fontPairing) {
    return {
      ok: false,
      error: `treatment "${id}" references unknown fontPairing "${treatment.fontPairing}"`,
      knownIds: catalog.treatments.map(t => t.id),
    };
  }
  return { ok: true, treatment, palettes, fontPairing };
}

// Plain text, no ANSI: keeps output safe for cron mail, webhooks, and CI logs.
export function formatThemesList(report: ThemesListReport): string {
  const header = ['id', 'family', 'palettes', 'fontPairing'];
  const rows = report.treatments.map(t => [
    t.id,
    t.family,
    String(t.paletteCount),
    t.fontPairing,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out: string[] = [];
  out.push(`── themes (${report.treatments.length} treatments, fallback=${report.fallback}) ──`);
  out.push('');
  out.push('  ' + line(header));
  out.push('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) out.push('  ' + line(row));
  out.push('');
  out.push('Run `postiz-agent themes describe <id>` for palette hex codes and font details.');
  return out.join('\n');
}

export interface CheckDecisionsRow {
  bundleId: string;
  treatmentId: string;
  reason: ThemeDecisionStaleReason;
  catalogVersion?: string;
  currentCatalogVersion: string;
}

export interface CheckDecisionsOptions {
  catalog?: ThemeCatalog;
  store?: ThemeDecisionStore;
  fix?: boolean;
}

export interface CheckDecisionsResult {
  stale: CheckDecisionsRow[];
  cleared: CheckDecisionsRow[];
  currentCatalogVersion: string;
}

export function checkDecisions(opts: CheckDecisionsOptions = {}): CheckDecisionsResult {
  const catalog = opts.catalog ?? loadCatalog();
  const store = opts.store ?? new ThemeDecisionStore();
  const staleEntries = store.listStale(catalog);
  const stale = staleEntries.map(e => toRow(e, catalog.catalogVersion));

  let cleared: CheckDecisionsRow[] = [];
  if (opts.fix && staleEntries.length > 0) {
    const removed = store.clearStale(catalog);
    cleared = removed.map(e => toRow(e, catalog.catalogVersion));
  }

  return {
    stale,
    cleared,
    currentCatalogVersion: catalog.catalogVersion,
  };
}

function toRow(entry: StaleDecisionEntry, currentCatalogVersion: string): CheckDecisionsRow {
  return {
    bundleId: entry.bundleId,
    treatmentId: entry.decision.treatmentId,
    reason: entry.reason,
    catalogVersion: entry.decision.catalogVersion,
    currentCatalogVersion,
  };
}

export function formatCheckDecisions(result: CheckDecisionsResult, opts: { fix?: boolean } = {}): string {
  const out: string[] = [];
  const suffix = opts.fix ? ` (cleared ${result.cleared.length})` : '';
  out.push(`── theme decisions check (catalogVersion=${result.currentCatalogVersion})${suffix} ──`);
  out.push('');
  if (result.stale.length === 0) {
    out.push('  no stale decisions');
    return out.join('\n');
  }
  const header = ['bundleId', 'treatmentId', 'reason', 'wasVersion'];
  const rows = result.stale.map(r => [
    r.bundleId,
    r.treatmentId,
    r.reason,
    r.catalogVersion ?? '(none)',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  out.push('  ' + line(header));
  out.push('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) out.push('  ' + line(row));
  out.push('');
  if (opts.fix) {
    out.push(`cleared ${result.cleared.length} stale entr${result.cleared.length === 1 ? 'y' : 'ies'}. Next publish will re-resolve.`);
  } else {
    out.push('Run with --fix to clear stale entries (next publish will re-resolve them).');
  }
  return out.join('\n');
}

export function formatThemeDescription(desc: ThemeDescriptor): string {
  const { treatment, palettes, fontPairing } = desc;
  const out: string[] = [];
  out.push(`── ${treatment.id} (${treatment.family}) ──`);
  out.push('');
  out.push(treatment.description);
  out.push('');
  out.push(`palettes (${palettes.length}):`);
  for (const p of palettes) {
    out.push(`  ${p.id.padEnd(20)} bg=${p.bg} ink=${p.ink} accent=${p.accent}`);
  }
  out.push('');
  out.push(`fontPairing: ${fontPairing.id}`);
  out.push(`  display: ${fontPairing.display.family} (${fontPairing.display.weights.join(', ')})`);
  out.push(`  body:    ${fontPairing.body.family} (${fontPairing.body.weights.join(', ')})`);
  if (fontPairing.folio) {
    out.push(`  folio:   ${fontPairing.folio.family} (${fontPairing.folio.weights.join(', ')})`);
  }
  if (treatment.layoutHints && Object.keys(treatment.layoutHints).length > 0) {
    out.push('');
    out.push('layoutHints:');
    for (const [k, v] of Object.entries(treatment.layoutHints)) {
      out.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  return out.join('\n');
}
