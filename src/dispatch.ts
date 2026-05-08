import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionLogEntry, Platform } from './types.js';

export interface DispatchCandidate {
  /** Content slug (basename of the source files, without extension). */
  slug: string;
  /** Ordering timestamp in ms since epoch. Prefer meta.generatedAt; fall back to file mtime. */
  generatedAtMs: number;
}

const PUBLISHED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Select the oldest candidate that is NOT yet fully published (successful publish
 * within the last 30 days) to ALL requested platforms. Returns null when every
 * candidate already has a successful publish on every requested platform. Pure
 * function so we can unit-test it with fixture log + candidates.
 */
export function selectNextContent(
  candidates: DispatchCandidate[],
  log: DecisionLogEntry[],
  platforms: Platform[],
  now: Date = new Date(),
): string | null {
  if (candidates.length === 0 || platforms.length === 0) return null;

  const cutoffMs = now.getTime() - PUBLISHED_WINDOW_MS;
  const successByContent = new Map<string, Set<Platform>>();
  for (const e of log) {
    if (!e.result?.success) continue;
    const createdMs = Date.parse(e.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;
    const contentSlug = e.contentSlug ?? e.storySlug;
    if (!contentSlug) continue;
    let set = successByContent.get(contentSlug);
    if (!set) { set = new Set(); successByContent.set(contentSlug, set); }
    set.add(e.platform);
  }

  const sorted = [...candidates].sort((a, b) => a.generatedAtMs - b.generatedAtMs);
  for (const c of sorted) {
    const published = successByContent.get(c.slug) ?? new Set<Platform>();
    const pending = platforms.some(p => !published.has(p));
    if (pending) return c.slug;
  }
  return null;
}

/** Backward-compatible export name. Prefer selectNextContent. */
export const selectNextStory = selectNextContent;

/**
 * Walk the content output dir for *.json + *.mp3 pairs. Returns one candidate
 * per complete pair with the best-available generation timestamp.
 */
export function listCandidates(contentDir: string): DispatchCandidate[] {
  if (!existsSync(contentDir)) return [];
  const files = readdirSync(contentDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const out: DispatchCandidate[] = [];
  for (const jsonFile of files) {
    const slug = jsonFile.replace(/\.json$/, '');
    const mp3Path = join(contentDir, `${slug}.mp3`);
    if (!existsSync(mp3Path)) continue;
    const jsonPath = join(contentDir, jsonFile);
    let generatedAtMs = statSync(jsonPath).mtimeMs;
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { meta?: { generatedAt?: string } };
      const ga = raw?.meta?.generatedAt;
      if (ga) {
        const parsed = Date.parse(ga);
        if (Number.isFinite(parsed)) generatedAtMs = parsed;
      }
    } catch {
      // non-fatal; rely on mtime
    }
    out.push({ slug, generatedAtMs });
  }
  return out;
}
