import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { wasRecentlyPublished } from '../../src/idempotency.js';
import { selectNextStory, selectPendingPlatforms } from '../../src/dispatch.js';
import { SubtitleGenerator } from '../../src/media/subtitles.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { PublishContext } from '../../src/platforms/base.js';
import type { DecisionLogEntry, PublishResult } from '../../src/types.js';

const bundle: ContentBundle = { id: 'product', kind: 'text', locale: 'es', text: { body: 'A product update' } };
const success = (): PublishResult => ({ platform: 'x', success: true, postId: 'published', timestamp: new Date().toISOString() });
const entry = (result: PublishResult): DecisionLogEntry => ({ id: 'id', action: 'publish.x', storySlug: bundle.id, platform: 'x', createdAt: new Date().toISOString(), reason: 'test', result });

describe('publishing reliability', () => {
  let dir: string;
  let decisions: DecisionLog;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publishing-reliability-'));
    decisions = new DecisionLog(join(dir, 'decisions.jsonl'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  function orchestrator(publish = vi.fn(async (_ctx: PublishContext) => success())) {
    return new Orchestrator({ decisions, getPublisher: () => ({ platform: 'x', publish }), preflight: async () => ({ ok: true }) });
  }

  it('a dry run never suppresses the following real publication', async () => {
    const publish = vi.fn(async (_ctx: PublishContext) => success());
    const orch = orchestrator(publish);
    await orch.publish({ bundle, platforms: ['x'], dryRun: true });
    const real = await orch.publish({ bundle, platforms: ['x'] });
    expect(real.results[0].skipped).not.toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(decisions.list()).toHaveLength(1);
  });

  it('rejects overlap across independent orchestrators sharing a decision log', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const publish = vi.fn(async () => { started(); await gate; return success(); });
    const first = orchestrator(publish).publish({ bundle, platforms: ['x'] });
    await ready;
    const second = orchestrator().publish({ bundle, platforms: ['x'] });
    try { await expect(second).rejects.toThrow(/publication lock/i); }
    finally { finish(); await first; }
  });

  it('deduplicates repeated platforms within a single invocation', async () => {
    const publish = vi.fn(async (_ctx: PublishContext) => success());
    const report = await orchestrator(publish).publish({ bundle, platforms: ['x', 'x'] });
    expect(report.results).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not pass product images to Whisper', async () => {
    const transcribe = vi.spyOn(SubtitleGenerator.prototype, 'generate').mockRejectedValue(new Error('image has no audio'));
    const report = await orchestrator().publish({ bundle: { ...bundle, kind: 'image-post', primaryMedia: '/test.png' }, platforms: ['x'] });
    expect(transcribe).not.toHaveBeenCalled();
    expect(report.results[0]?.success).toBe(true);
  });

  it('does not reuse the same render directory on successive runs', async () => {
    const directories: string[] = [];
    const publish = vi.fn(async (ctx: PublishContext) => { directories.push(ctx.workDir); return success(); });
    const orch = orchestrator(publish);
    await orch.publish({ bundle, platforms: ['x'], force: true });
    await orch.publish({ bundle, platforms: ['x'], force: true });
    expect(new Set(directories).size).toBe(2);
  });

  it('ignores legacy preview successes and manual reset markers', () => {
    const preview = entry({ ...success(), url: 'file:///tmp/preview.mp4' });
    const reset = { ...entry({ ...success(), skipped: true }), action: 'reset-attempts.x' };
    expect(wasRecentlyPublished([preview], bundle.id, 'x').recent).toBe(false);
    expect(selectNextStory([{ slug: bundle.id, generatedAtMs: 0 }], [preview, reset], ['x'])).toBe(bundle.id);
  });

  it('keeps a multipart publication pending until every part succeeds', () => {
    const first = entry({ ...success(), partIndex: 1, partTotal: 2 });
    const second = entry({ ...success(), success: false, partIndex: 2, partTotal: 2 });
    expect(wasRecentlyPublished([first, second], bundle.id, 'x').recent).toBe(false);
    expect(selectNextStory([{ slug: bundle.id, generatedAtMs: 0 }], [first, second], ['x'])).toBe(bundle.id);
  });

  it('retains deduplication after the active decision log rotates', async () => {
    await decisions.record({ action: 'publish.x', storySlug: bundle.id, platform: 'x', reason: 'test', result: success() });
    decisions.rotate();
    const publish = vi.fn(async (_ctx: PublishContext) => success());
    const report = await orchestrator(publish).publish({ bundle, platforms: ['x'] });
    expect(report.results[0].skipped).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never overwrites archives when rotation occurs twice in one second', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-06T10:00:00Z'));
      await decisions.record({ action: 'publish.x', storySlug: 'first', platform: 'x', reason: 'test', result: success() });
      const first = decisions.rotate();
      await decisions.record({ action: 'publish.x', storySlug: 'second', platform: 'x', reason: 'test', result: success() });
      const second = decisions.rotate();
      expect(first.rotatedTo).not.toBe(second.rotatedTo);
      expect(decisions.listArchives()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('only retries unfinished, unblocked platforms after more than 24 hours', () => {
    const old = { ...entry(success()), createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() };
    const blocked = { ...entry({ platform: 'instagram', success: false, errorClass: 'transient', timestamp: new Date().toISOString() }), platform: 'instagram' as const };
    expect(selectPendingPlatforms([old, blocked], bundle.id, ['x', 'instagram', 'youtube'])).toEqual(['youtube']);
  });

  it('never retries an ambiguous remote creation until its attempts are reset', async () => {
    const uncertain: PublishResult = { platform: 'x', success: false, errorClass: 'needs-human', error: 'Postiz 503 outcome unknown', remediation: { action: 'reconcile-post', humanHint: 'Check the remote post before retrying' }, timestamp: new Date().toISOString() };
    const historical = { ...entry(uncertain), createdAt: new Date(Date.now() - 96 * 3_600_000).toISOString() };
    expect(selectPendingPlatforms([historical], bundle.id, ['x'])).toEqual([]);
    await decisions.record({ action: 'publish.x', storySlug: bundle.id, platform: 'x', reason: 'test', result: uncertain });
    const publish = vi.fn(async (_ctx: PublishContext) => success());
    const report = await orchestrator(publish).publish({ bundle, platforms: ['x'] });
    expect(publish).not.toHaveBeenCalled();
    expect(report.results[0]).toMatchObject({ success: false, errorClass: 'needs-human' });
    const reset = { ...entry({ ...success(), skipped: true }), action: 'reset-attempts.x' };
    expect(selectPendingPlatforms([historical, reset], bundle.id, ['x'])).toEqual(['x']);
  });

  it('retains the publication lock if a remote success cannot be recorded', async () => {
    vi.spyOn(decisions, 'record').mockRejectedValue(new Error('disk full'));
    const report = await orchestrator().publish({ bundle, platforms: ['x'] });
    expect(report.results[0].success).toBe(false);
    expect(existsSync(join(dir, 'decisions.jsonl.publish.lock'))).toBe(true);
    await expect(orchestrator().publish({ bundle, platforms: ['x'] })).rejects.toThrow(/publication lock/i);
  });

  it('rejects inline identifiers that can escape render directories', async () => {
    await expect(orchestrator().publish({ bundle: { ...bundle, id: '../outside' }, platforms: ['x'] })).rejects.toThrow(/Invalid slug/i);
  });
});
