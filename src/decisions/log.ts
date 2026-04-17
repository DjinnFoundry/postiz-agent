import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../types.js';

/**
 * Lightweight JSONL decision log (inspired by YouTubeCLI).
 * Every publish attempt is recorded: what was posted, why, and the result.
 * Later we can query this to measure outcomes (engagement) and learn patterns.
 */
export class DecisionLog {
  private readonly logPath: string;

  constructor(logPath?: string) {
    const dir = join(config.paths.projectRoot, 'data');
    mkdirSync(dir, { recursive: true });
    this.logPath = logPath ?? join(dir, 'decisions.jsonl');
  }

  record(params: {
    action: string;
    storySlug: string;
    platform: Platform;
    reason: string;
    result: PublishResult;
  }): DecisionLogEntry {
    const entry: DecisionLogEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...params,
    };
    const line = JSON.stringify(entry) + '\n';
    writeFileSync(this.logPath, line, { flag: 'a' });
    return entry;
  }

  list(filter?: { storySlug?: string; platform?: Platform }): DecisionLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l) as DecisionLogEntry);
    return entries.filter(e => {
      if (filter?.storySlug && e.storySlug !== filter.storySlug) return false;
      if (filter?.platform && e.platform !== filter.platform) return false;
      return true;
    });
  }
}
