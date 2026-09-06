import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { SubtitleGenerator } from '../../src/media/subtitles.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { PreflightResult } from '../../src/core/preflight.js';
import type { PublishContext } from '../../src/platforms/base.js';
import type { Platform, PublishResult } from '../../src/types.js';

const bundle: ContentBundle = {
  id: 'early-guards', kind: 'audio-story', locale: 'es',
  primaryMedia: '/unused/audio.mp3', text: { body: 'Hola' },
};

describe('Orchestrator guards before expensive preparation', () => {
  let dir: string;
  let decisions: DecisionLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchestrator-early-guards-'));
    decisions = new DecisionLog(join(dir, 'decisions.jsonl'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  async function recordPrevious(platform: Platform, uncertain = false) {
    const result: PublishResult = {
      platform, success: !uncertain, timestamp: new Date().toISOString(),
      ...(uncertain
        ? { errorClass: 'needs-human' as const, remediation: { action: 'reconcile-post', humanHint: 'Check remote posts' } }
        : { postId: `previous-${platform}` }),
    };
    await decisions.record({ action: `publish.${platform}`, storySlug: bundle.id, platform, reason: 'previous run', result });
  }

  function pipeline() {
    const transcribe = vi.spyOn(SubtitleGenerator.prototype, 'generate').mockResolvedValue({
      words: [{ text: 'Hola', start: 0, end: 1 }], jsonPath: join(dir, 'captions.json'),
    });
    const preflight = vi.fn(async (_bundle: ContentBundle, _platform: Platform): Promise<PreflightResult> => ({ ok: true }));
    const publish = vi.fn(async (_ctx: PublishContext): Promise<PublishResult> => ({
      platform: 'tiktok', success: true, postId: 'new-post', timestamp: new Date().toISOString(),
    }));
    const getPublisher = vi.fn((platform: Platform) => ({ platform, publish }));
    const orchestrator = new Orchestrator({ decisions, workDir: join(dir, 'work'), preflight, getPublisher });
    return { orchestrator, transcribe, preflight, getPublisher, publish };
  }

  it('skips every recently published platform before preflight or unavailable Whisper', async () => {
    await recordPrevious('x');
    await recordPrevious('tiktok');
    const p = pipeline();
    p.transcribe.mockRejectedValue(new Error('Whisper unavailable'));

    const report = await p.orchestrator.publish({ bundle, platforms: ['x', 'tiktok'] });

    expect(p.preflight).not.toHaveBeenCalled();
    expect(p.transcribe).not.toHaveBeenCalled();
    expect(p.getPublisher).not.toHaveBeenCalled();
    expect(report.fatalCaptionFailure).toBeUndefined();
    expect(report.results).toMatchObject([
      { platform: 'x', success: true, skipped: true, reason: 'already published today', captionStatus: 'skipped' },
      { platform: 'tiktok', success: true, skipped: true, reason: 'already published today', captionStatus: 'skipped' },
    ]);
    expect(decisions.list().filter(e => e.runId === report.runId).map(e => e.action).sort())
      .toEqual(['publish.tiktok.skipped', 'publish.x.skipped']);
  });

  it('blocks uncertain platforms before preflight or transcription without adding attempts', async () => {
    await recordPrevious('x', true);
    await recordPrevious('tiktok', true);
    const p = pipeline();
    p.transcribe.mockRejectedValue(new Error('Whisper unavailable'));

    const report = await p.orchestrator.publish({ bundle, platforms: ['x', 'tiktok'] });

    expect(p.preflight).not.toHaveBeenCalled();
    expect(p.transcribe).not.toHaveBeenCalled();
    expect(p.getPublisher).not.toHaveBeenCalled();
    expect(report.fatalCaptionFailure).toBeUndefined();
    expect(report.results).toMatchObject([
      { platform: 'x', success: false, skipped: true, errorClass: 'needs-human', remediation: { action: 'reconcile-post' } },
      { platform: 'tiktok', success: false, skipped: true, errorClass: 'needs-human', remediation: { action: 'reconcile-post' } },
    ]);
    expect(decisions.list()).toHaveLength(2);
  });

  it('prepares only a pending platform when another platform was recently published', async () => {
    await recordPrevious('x');
    const p = pipeline();

    const report = await p.orchestrator.publish({ bundle, platforms: ['x', 'tiktok'] });

    expect(p.preflight).toHaveBeenCalledExactlyOnceWith(bundle, 'tiktok');
    expect(p.transcribe).toHaveBeenCalledTimes(1);
    expect(p.getPublisher).toHaveBeenCalledExactlyOnceWith('tiktok');
    expect(p.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ words: [{ text: 'Hola', start: 0, end: 1 }] }));
    expect(report.results).toMatchObject([
      { platform: 'x', success: true, skipped: true, captionStatus: 'skipped' },
      { platform: 'tiktok', success: true, postId: 'new-post', captionStatus: 'ok' },
    ]);
    expect(decisions.list().filter(e => e.runId === report.runId).map(e => e.action).sort())
      .toEqual(['publish.tiktok', 'publish.x.skipped']);
  });

  it.each([
    { uncertain: false, force: true, dryRun: false },
    { uncertain: true, force: true, dryRun: false },
    { uncertain: false, force: false, dryRun: true },
    { uncertain: true, force: false, dryRun: true },
  ])('preserves explicit bypass: %j', async ({ uncertain, force, dryRun }) => {
    await recordPrevious('tiktok', uncertain);
    const p = pipeline();

    const report = await p.orchestrator.publish({ bundle, platforms: ['tiktok'], force, dryRun });

    expect(p.preflight).toHaveBeenCalledTimes(1);
    expect(p.transcribe).toHaveBeenCalledTimes(1);
    expect(p.publish).toHaveBeenCalledTimes(1);
    expect(report.results[0]).toMatchObject({ success: true, postId: 'new-post' });
    expect(decisions.list()).toHaveLength(dryRun ? 1 : 2);
  });
});
