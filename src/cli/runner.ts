import { existsSync, readFileSync } from 'node:fs';
import { ContentBundleSchema, type ContentBundle } from '../core/content-bundle.js';
import { validateSlug } from '../lib/slug.js';
import { assertSafeBundlePath } from '../lib/safe-path.js';
import { AudioKidsAdapter } from '../adapters/audiokids.js';
import { DEFAULT_ADAPTER } from '../adapters/registry.js';
import { PlatformSchema, type Platform } from '../types.js';
import type { StuckSlugInfo } from '../dispatch.js';
import type { GalleryAspect } from './gallery.js';

/**
 * Shared CLI helpers extracted out of the per-subcommand registrars. Pure
 * functions, no commander dependency, no process.exit — every helper either
 * returns a value or throws so the calling action can decide how to react
 * (commander surfaces the throw as a top-level error, agent-friendly).
 */

/** Parse the comma-separated `--platforms x,tiktok,...` flag into validated Platform values. */
export function parsePlatforms(csv: string): Platform[] {
  return csv
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => PlatformSchema.parse(p));
}

/**
 * Decide where the bundle for publish/render comes from. Mutually exclusive:
 *   1. --bundle-file <path>  inline ContentBundle JSON, no adapter involved
 *   2. --slug / --id <id>    resolved by the chosen adapter (default 'audiokids')
 * Throws when both or neither are present.
 */
export function resolvePublishSource(opts: { slug?: string; id?: string; adapter?: string; bundleFile?: string }):
  { id?: string; storySlug?: string; adapter?: string; bundle?: ContentBundle } {
  const id = opts.id ?? opts.slug;
  if (opts.bundleFile && id) {
    throw new Error('pass either --slug/--id or --bundle-file, not both');
  }
  if (opts.bundleFile) {
    if (!existsSync(opts.bundleFile)) throw new Error(`bundle file not found: ${opts.bundleFile}`);
    return { bundle: ContentBundleSchema.parse(JSON.parse(readFileSync(opts.bundleFile, 'utf-8'))) };
  }
  if (!id) {
    throw new Error('one of --slug/--id or --bundle-file is required');
  }
  return { id: validateSlug(id), adapter: opts.adapter ?? DEFAULT_ADAPTER };
}

/**
 * Resolve a ContentBundle for the read-only commands (gallery, copy preview,
 * tools call, run-pipeline). Differs from resolvePublishSource: returns the
 * fully-loaded bundle instead of an opts shape, and uses the audiokids adapter
 * directly without going through the registry (no tenant / no per-tenant
 * outputDir override needed for these single-shot inspections).
 */
export function resolveBundle(opts: { id?: string; bundleFile?: string }): ContentBundle {
  if (opts.bundleFile) {
    const safe = assertSafeBundlePath(opts.bundleFile);
    if (!existsSync(safe)) throw new Error(`bundle file not found: ${opts.bundleFile}`);
    return ContentBundleSchema.parse(JSON.parse(readFileSync(safe, 'utf-8')));
  }
  if (!opts.id) throw new Error('pass --id <slug> or --bundle-file <path> to resolve a ContentBundle');
  return new AudioKidsAdapter().loadBundle(opts.id);
}

/** Validate the gallery `--aspect` flag. */
export function parseAspect(raw: string | undefined): GalleryAspect {
  const v = (raw ?? 'square').toLowerCase();
  if (v === 'square' || v === 'portrait' || v === 'landscape') return v;
  throw new Error(`invalid --aspect ${raw}: must be square | portrait | landscape`);
}

/** Tabular ASCII rendering for `decisions --stuck`. JSON consumers go through plain stringify. */
export function formatStuckTable(rows: StuckSlugInfo[]): string {
  if (rows.length === 0) return 'no stuck slugs';
  const headers = ['slug', 'platform', 'reason', 'remediation', 'next-eligible-at'];
  const body = rows.map(r => [
    truncate(r.slug, 24),
    truncate(r.platform, 10),
    truncate(r.reason, 28),
    truncate(r.lastRemediation?.action ?? '', 20),
    truncate(r.nextEligibleAt ?? '', 25),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  return [pad(headers), sep, ...body.map(pad)].join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
