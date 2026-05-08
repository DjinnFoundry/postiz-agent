import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../types.js';

/**
 * Lightweight JSONL decision log (inspired by YouTubeCLI).
 * Every publish attempt is recorded: what was posted, why, and the result.
 * Appends are async + POSIX-atomic per line, so the orchestrator can record
 * decisions from concurrent platform publishes without corrupting the file.
 */
export class DecisionLog {
  private readonly logPath: string;

  constructor(logPath?: string) {
    const dir = join(config.paths.projectRoot, 'data');
    mkdirSync(dir, { recursive: true });
    this.logPath = logPath ?? join(dir, 'decisions.jsonl');
  }

  async record(params: {
    action: string;
    contentSlug: string;
    platform: Platform;
    reason: string;
    result: PublishResult;
  }): Promise<DecisionLogEntry> {
    const entry: DecisionLogEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...params,
    };
    await appendFile(this.logPath, JSON.stringify(entry) + '\n');
    return entry;
  }

  list(filter?: { contentSlug?: string; platform?: Platform }): DecisionLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    const entries = lines
      .map(l => normalizeEntry(JSON.parse(l) as DecisionLogEntry & { storySlug?: string }))
      .filter((e): e is DecisionLogEntry => Boolean(e));
    return entries.filter(e => {
      if (filter?.contentSlug && e.contentSlug !== filter.contentSlug) return false;
      if (filter?.platform && e.platform !== filter.platform) return false;
      return true;
    });
  }
}

function normalizeEntry(entry: DecisionLogEntry & { storySlug?: string }): DecisionLogEntry | null {
  const contentSlug = entry.contentSlug ?? entry.storySlug;
  if (!contentSlug) return null;
  return { ...entry, contentSlug };
}
