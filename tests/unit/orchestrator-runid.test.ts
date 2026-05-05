import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { AudioKidsAdapter } from '../../src/adapters/audiokids.js';
import type { PlatformPublisher, PublishContext } from '../../src/platforms/base.js';
import type { Platform, PublishResult } from '../../src/types.js';

/**
 * Verifies that Orchestrator.publish() mints exactly one runId per call and propagates
 * it to every decision log entry emitted during that call (including IG multi-part,
 * which records one entry per part). Two separate publish() calls must produce two
 * distinct runIds so log consumers can correlate entries without false positives.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeStoryFixture(dir: string, slug: string): void {
  const json = {
    titulo: 'T',
    contenido: 'Un cuento de prueba.',
    mood: 'calma',
    meta: {
      slug,
      age: 5,
      mood: 'calma',
      locale: 'es-ES',
      name: 'Kid',
      nivel: 1,
      model: 'test',
      wordCount: 3,
      sentenceCount: 1,
      estimatedDurationMin: 1,
    },
  };
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(json), 'utf-8');
  writeFileSync(join(dir, `${slug}.mp3`), 'fake-mp3-bytes', 'utf-8');
}

function makeMultiPartPublisher(platform: Platform): PlatformPublisher {
  return {
    platform,
    async publish(_ctx: PublishContext): Promise<PublishResult> {
      const ts = new Date().toISOString();
      const parts: PublishResult[] = [
        { platform, success: true, postId: 'p1', url: 'u1', timestamp: ts, partIndex: 1, partTotal: 2 },
        { platform, success: true, postId: 'p2', url: 'u2', timestamp: ts, partIndex: 2, partTotal: 2 },
      ];
      return { platform, success: true, timestamp: ts, parts };
    },
  };
}

function makeSinglePublisher(platform: Platform): PlatformPublisher {
  return {
    platform,
    async publish(_ctx: PublishContext): Promise<PublishResult> {
      return { platform, success: true, postId: 'single', url: 'u', timestamp: new Date().toISOString() };
    },
  };
}

describe('Orchestrator runId propagation', () => {
  let dir: string;
  let akDir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postiz-agent-runid-'));
    akDir = join(dir, 'ak');
    mkdirSync(akDir, { recursive: true });
    writeStoryFixture(akDir, 'test-slug');
    logPath = join(dir, 'decisions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('propagates a single runId to every entry emitted by one publish() call, including multi-part', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: (p) => p === 'instagram' ? makeMultiPartPublisher(p) : makeSinglePublisher(p),
      preflight: async () => ({ ok: true as const }),
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['instagram', 'tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(report.runId).toBeDefined();
    expect(UUID_RE.test(report.runId!)).toBe(true);

    expect(existsSync(logPath)).toBe(true);
    const entries = decisions.list();
    expect(entries.length).toBe(3);
    expect(entries.every(e => e.runId === report.runId)).toBe(true);
  });

  it('mints a distinct runId for each publish() call', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: (p) => makeSinglePublisher(p),
      preflight: async () => ({ ok: true as const }),
    });

    const r1 = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });
    const r2 = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(r1.runId).toBeDefined();
    expect(r2.runId).toBeDefined();
    expect(r1.runId).not.toBe(r2.runId);

    const entries = decisions.list();
    const byRun = new Map<string, number>();
    for (const e of entries) {
      const k = e.runId ?? '<none>';
      byRun.set(k, (byRun.get(k) ?? 0) + 1);
    }
    expect(byRun.get(r1.runId!)).toBe(1);
    expect(byRun.get(r2.runId!)).toBe(1);
  });

});
