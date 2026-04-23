import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { UploadCache } from '../lib/upload-cache.js';

export interface PruneRenderLogsOptions {
  dir?: string;
  olderThanDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface PruneRenderLogsResult {
  dir: string;
  olderThanDays: number;
  removed: number;
  kept: number;
  bytesFreed: number;
  removedFiles: string[];
  dryRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function pruneRenderLogs(opts: PruneRenderLogsOptions = {}): Promise<PruneRenderLogsResult> {
  const dir = opts.dir ?? config.paths.renderLogsDir;
  const olderThanDays = opts.olderThanDays ?? config.housekeeping.renderLogsRetentionDays;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();

  const base: PruneRenderLogsResult = {
    dir,
    olderThanDays,
    removed: 0,
    kept: 0,
    bytesFreed: 0,
    removedFiles: [],
    dryRun,
  };

  if (!existsSync(dir)) return base;
  if (!(olderThanDays > 0)) {
    let kept = 0;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.log')) kept++;
    }
    base.kept = kept;
    return base;
  }

  const cutoff = now.getTime() - olderThanDays * DAY_MS;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return base;
  }

  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) {
      base.bytesFreed += st.size;
      base.removedFiles.push(full);
      base.removed++;
      if (!dryRun) {
        try { unlinkSync(full); } catch { /* noop */ }
      }
    } else {
      base.kept++;
    }
  }

  return base;
}

export interface PruneUploadCacheOptions {
  cache?: UploadCache;
  dryRun?: boolean;
}

export interface PruneUploadCacheResult {
  removed: number;
  kept: number;
  dryRun: boolean;
}

export function pruneUploadCache(opts: PruneUploadCacheOptions = {}): PruneUploadCacheResult {
  const cache = opts.cache ?? new UploadCache();
  const dryRun = opts.dryRun ?? false;
  if (dryRun) {
    const before = cache.summarize();
    const wouldRemove = cache.countStale();
    return { removed: wouldRemove, kept: before.count - wouldRemove, dryRun };
  }
  const removed = cache.prune();
  const after = cache.summarize();
  return { removed, kept: after.count, dryRun };
}
