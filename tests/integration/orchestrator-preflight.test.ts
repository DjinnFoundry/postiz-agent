import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { AudioKidsAdapter } from '../../src/adapters/audiokids.js';
import type { PreflightResult } from '../../src/core/preflight.js';
import type { PlatformPublisher, PublishContext } from '../../src/platforms/base.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { Platform, PublishResult } from '../../src/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeStoryFixture(dir: string, slug: string): void {
  const json = {
    titulo: 'Preflight Test',
    contenido: 'Un cuento de prueba para preflight.',
    mood: 'calma',
    meta: {
      slug,
      age: 5,
      mood: 'calma',
      locale: 'es-ES',
      name: 'Kid',
      nivel: 1,
      model: 'test',
      wordCount: 5,
      sentenceCount: 1,
      estimatedDurationMin: 1,
    },
  };
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(json), 'utf-8');
  writeFileSync(join(dir, `${slug}.mp3`), 'fake-mp3-bytes', 'utf-8');
}

function makeSpyPublisher(platform: Platform): { publisher: PlatformPublisher; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (_ctx: PublishContext): Promise<PublishResult> => ({
    platform,
    success: true,
    postId: 'ok',
    url: `https://example.test/${platform}`,
    timestamp: new Date().toISOString(),
  }));
  return {
    publisher: { platform, publish: spy } as PlatformPublisher,
    spy,
  };
}

describe('Orchestrator preflight short-circuit', () => {
  let dir: string;
  let akDir: string;
  let logPath: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postiz-agent-preflight-'));
    akDir = join(dir, 'ak');
    mkdirSync(akDir, { recursive: true });
    writeStoryFixture(akDir, 'test-slug');
    logPath = join(dir, 'decisions.jsonl');
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('A) preflight permanent fail: publisher.publish is NOT called, decision log records preflight entry with errorClass, report marks skipped + errorClass', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const { publisher, spy } = makeSpyPublisher('tiktok');

    const preflight = vi.fn(async (_bundle: ContentBundle, _platform: Platform): Promise<PreflightResult> => ({
      ok: false,
      kind: 'permanent',
      reason: 'audio too long',
      hint: 'shorten',
    }));

    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: () => publisher,
      preflight,
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);

    expect(report.results).toHaveLength(1);
    const r = report.results[0]!;
    expect(r.platform).toBe('tiktok');
    expect(r.skipped).toBe(true);
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('permanent');
    expect(r.reason).toBe('audio too long');
    expect(r.error).toBe('audio too long');
    expect(r.remediation).toEqual({ action: 'preflight-fix', humanHint: 'shorten' });

    const entries = decisions.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.action).toBe('publish.tiktok.preflight');
    expect(entry.platform).toBe('tiktok');
    expect(entry.storySlug).toBe('test-slug');
    expect(entry.result.success).toBe(false);
    expect(entry.result.errorClass).toBe('permanent');
    expect(entry.result.reason).toBe('audio too long');

    const failed = report.results.filter(x => !x.success);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it("B) preflight soft skip (kind='skip'): publisher.publish NOT called, log entry recorded, report marks skipped + success with no errorClass", async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const { publisher, spy } = makeSpyPublisher('spotify');

    const preflight = vi.fn(async (): Promise<PreflightResult> => ({
      ok: false,
      kind: 'skip',
      reason: 'spotify is RSS-only',
    }));

    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: () => publisher,
      preflight,
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['spotify'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(spy).not.toHaveBeenCalled();

    const r = report.results[0]!;
    expect(r.skipped).toBe(true);
    expect(r.success).toBe(true);
    expect(r.errorClass).toBeUndefined();
    expect(r.reason).toBe('spotify is RSS-only');
    expect(r.error).toBeUndefined();

    const entries = decisions.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.action).toBe('publish.spotify.preflight');
    expect(entry.result.success).toBe(true);
    expect(entry.result.skipped).toBe(true);
    expect(entry.result.errorClass).toBeUndefined();
  });

  it('C) preflight ok: publisher.publish IS called and flow proceeds normally', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const { publisher, spy } = makeSpyPublisher('tiktok');

    const preflight = vi.fn(async (): Promise<PreflightResult> => ({ ok: true }));

    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: () => publisher,
      preflight,
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);

    const r = report.results[0]!;
    expect(r.platform).toBe('tiktok');
    expect(r.success).toBe(true);
    expect(r.skipped).toBeFalsy();
    expect(r.postId).toBe('ok');

    const entries = decisions.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('publish.tiktok');
  });

  it('D) preflight permanent on one platform + ok on another, in parallel: each gets its own entry; only the ok one calls publish', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const { publisher: tiktokPub, spy: tiktokSpy } = makeSpyPublisher('tiktok');
    const { publisher: xPub, spy: xSpy } = makeSpyPublisher('x');

    const preflight = vi.fn(async (_bundle: ContentBundle, platform: Platform): Promise<PreflightResult> => {
      if (platform === 'x') {
        return { ok: false, kind: 'permanent', reason: 'audio too long for x', hint: 'shorten' };
      }
      return { ok: true };
    });

    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: (p) => (p === 'tiktok' ? tiktokPub : xPub),
      preflight,
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok', 'x'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(tiktokSpy).toHaveBeenCalledTimes(1);
    expect(xSpy).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(2);

    expect(report.results).toHaveLength(2);
    const byPlatform = Object.fromEntries(report.results.map(r => [r.platform, r]));
    expect(byPlatform.tiktok!.success).toBe(true);
    expect(byPlatform.tiktok!.skipped).toBeFalsy();
    expect(byPlatform.x!.success).toBe(false);
    expect(byPlatform.x!.skipped).toBe(true);
    expect(byPlatform.x!.errorClass).toBe('permanent');

    const entries = decisions.list();
    expect(entries).toHaveLength(2);
    const actions = entries.map(e => e.action).sort();
    expect(actions).toEqual(['publish.tiktok', 'publish.x.preflight']);
  });

  it('E) runId is propagated to the preflight decision entry', async () => {
    const decisions = new DecisionLog(logPath);
    const adapter = new AudioKidsAdapter(akDir);
    const { publisher } = makeSpyPublisher('tiktok');

    const preflight = vi.fn(async (): Promise<PreflightResult> => ({
      ok: false,
      kind: 'permanent',
      reason: 'audio too long',
      hint: 'shorten',
    }));

    const orch = new Orchestrator({
      adapter,
      decisions,
      getPublisher: () => publisher,
      preflight,
    });

    const report = await orch.publish({
      id: 'test-slug',
      platforms: ['tiktok'],
      skipTranscription: true,
      force: true,
      dryRun: false,
    });

    expect(report.runId).toBeDefined();
    expect(UUID_RE.test(report.runId!)).toBe(true);

    const entries = decisions.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe(report.runId);
  });
});
