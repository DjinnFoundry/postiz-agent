import { readFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../types.js';

/**
 * Lightweight JSONL decision log (inspired by YouTubeCLI).
 * Every publish attempt is recorded: what was posted, why, and the result.
 * Appends are async + POSIX-atomic per line, so the orchestrator can record
 * decisions from concurrent platform publishes without corrupting the file.
 *
 * Size-based rotation keeps list() O(active-file-size): when the active log
 * exceeds maxBytes it gets renamed to decisions-<ISO-timestamp>.jsonl and a
 * fresh empty file takes its place. Archives remain queryable via listArchives
 * but are not scanned on every list() call.
 */
export interface ArchiveInfo {
  path: string;
  sizeBytes: number;
  earliestTs?: string;
  latestTs?: string;
}

export interface RotateResult {
  rotatedTo: string;
  bytes: number;
}

export interface DecisionLogOptions {
  maxBytes?: number;
}

const ARCHIVE_RE = /^decisions-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/;

export class DecisionLog {
  private readonly logPath: string;
  private readonly maxBytes: number;

  constructor(logPath?: string, opts?: DecisionLogOptions) {
    const dir = join(config.paths.projectRoot, 'data');
    mkdirSync(dir, { recursive: true });
    this.logPath = logPath ?? join(dir, 'decisions.jsonl');
    this.maxBytes = opts?.maxBytes ?? config.decisions.logMaxBytes;
  }

  async record(params: {
    action: string;
    storySlug: string;
    platform: Platform;
    reason: string;
    result: PublishResult;
    runId?: string;
  }): Promise<DecisionLogEntry> {
    // Rotate before writing so the new entry lands in a fresh file and the
    // archive captures a self-contained slice of history.
    if (this.shouldRotate()) this.rotate();
    const entry: DecisionLogEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...params,
    };
    await appendFile(this.logPath, JSON.stringify(entry) + '\n');
    return entry;
  }

  list(filter?: { storySlug?: string; platform?: Platform; runId?: string }): DecisionLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l) as DecisionLogEntry);
    return entries.filter(e => {
      if (filter?.storySlug && e.storySlug !== filter.storySlug) return false;
      if (filter?.platform && e.platform !== filter.platform) return false;
      if (filter?.runId && e.runId !== filter.runId) return false;
      return true;
    });
  }

  shouldRotate(): boolean {
    if (!existsSync(this.logPath)) return false;
    return statSync(this.logPath).size > this.maxBytes;
  }

  rotate(): RotateResult {
    if (!existsSync(this.logPath)) return { rotatedTo: '', bytes: 0 };
    const bytes = statSync(this.logPath).size;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '').replace(/Z$/, '');
    const dir = dirname(this.logPath);
    const rotatedTo = join(dir, `decisions-${stamp}.jsonl`);
    renameSync(this.logPath, rotatedTo);
    return { rotatedTo, bytes };
  }

  listArchives(): ArchiveInfo[] {
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) return [];
    const active = basename(this.logPath);
    const files = readdirSync(dir)
      .filter(f => f !== active && ARCHIVE_RE.test(f))
      .map(f => join(dir, f));
    const infos: ArchiveInfo[] = files.map(p => {
      const sizeBytes = statSync(p).size;
      const info: ArchiveInfo = { path: p, sizeBytes };
      const firstLine = readFirstLine(p);
      const lastLine = readLastLine(p);
      if (firstLine) {
        try { info.earliestTs = (JSON.parse(firstLine) as DecisionLogEntry).createdAt; } catch { /* ignore malformed */ }
      }
      if (lastLine) {
        try { info.latestTs = (JSON.parse(lastLine) as DecisionLogEntry).createdAt; } catch { /* ignore malformed */ }
      }
      return info;
    });
    // Newest first so operators see recent archives at the top of the listing.
    infos.sort((a, b) => b.path.localeCompare(a.path));
    return infos;
  }
}

function readFirstLine(path: string): string | undefined {
  const content = readFileSync(path, 'utf-8');
  const nl = content.indexOf('\n');
  if (nl < 0) return content.length > 0 ? content : undefined;
  return content.slice(0, nl);
}

function readLastLine(path: string): string | undefined {
  const content = readFileSync(path, 'utf-8');
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  const nl = trimmed.lastIndexOf('\n');
  if (nl < 0) return trimmed.length > 0 ? trimmed : undefined;
  return trimmed.slice(nl + 1);
}
