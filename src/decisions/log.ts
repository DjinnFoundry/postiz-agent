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
    storySlug: string;
    platform: Platform;
    reason: string;
    result: PublishResult;
    runId?: string;
  }): Promise<DecisionLogEntry> {
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
}
