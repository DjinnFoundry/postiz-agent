import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { selectNextContent } from '../../src/dispatch.js';
import { wasRecentlyPublished } from '../../src/idempotency.js';
import { SlideVideoBuilder } from '../../src/media/slide-video.js';
import { SubtitleGenerator } from '../../src/media/subtitles.js';
import { PostizClient } from '../../src/platforms/postiz.js';
import type { PublishResult } from '../../src/types.js';
import { VideoPublisher } from '../../src/platforms/base.js';
import { ContentReader } from '../../src/content/reader.js';
import * as ffprobe from '../../src/lib/ffprobe.js';
import { isPublishedDecision, normalizePublishResult } from '../../src/publication-state.js';
import { findPublicationHold } from '../../src/idempotency.js';

// Isolated configuration: never load .env or touch an operator's content/logs.
vi.mock('../../src/config.js', () => ({
  config: {
    content: { outputDir: '', brand: 'Test', defaultLocale: 'es-ES' },
    paths: { projectRoot: '', tmpDir: '', assetsDir: '' },
    postiz: { apiUrl: 'https://postiz.invalid/public/v1', apiKey: '' },
    youtubecli: { path: '' },
    alerts: { webhookUrl: '' },
  },
  assertPostizConfigured: () => {},
}));

let root: string;
const slug = 'sample-item';
const options = { contentSlug: slug, platforms: ['tiktok'] as const };

class BoundaryPublisher extends VideoPublisher {
  readonly platform = 'tiktok';
  upload = vi.fn<() => Promise<Partial<PublishResult>>>();
}

function context() {
  return {
    assets: new ContentReader().readContent(slug), workDir: config.paths.tmpDir,
    words: [{ text: 'Sample', start: 0, end: 1 }],
  };
}

const part = (partIndex: number, partTotal = 2, outcome: PublishResult['outcome'] = 'accepted'): PublishResult => ({
  platform: 'tiktok', success: true, outcome, postId: `part-${partIndex}`, partIndex, partTotal,
  timestamp: new Date().toISOString(),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'postiz-publication-state-'));
  config.paths.projectRoot = root;
  config.paths.tmpDir = join(root, 'tmp');
  config.paths.assetsDir = join(root, 'assets');
  config.content.outputDir = join(root, 'content');
  mkdirSync(config.content.outputDir);
  writeFileSync(join(config.content.outputDir, `${slug}.json`), JSON.stringify({
    title: 'Sample item', content: 'Sample narration.', mood: 'fantasia', meta: { slug },
  }));
  writeFileSync(join(config.content.outputDir, `${slug}.mp3`), 'unit-test audio placeholder');
  writeFileSync(join(config.content.outputDir, `${slug}-cover.png`), 'unit-test cover placeholder');
  // Only expensive/external boundaries are stubbed. The registry, base publisher,
  // orchestrator, disk log, idempotency and dispatch are real.
  vi.spyOn(SubtitleGenerator.prototype, 'generate').mockResolvedValue({
    words: [{ text: 'Sample', start: 0, end: 1 }], jsonPath: join(root, 'words.json'),
  });
  vi.spyOn(SlideVideoBuilder.prototype, 'build').mockImplementation(async input => ({
    outputPath: input.outputPath, warnings: [],
  }));
  vi.spyOn(ffprobe, 'probeDurationSec').mockResolvedValue(60);
  vi.spyOn(PostizClient.prototype, 'findIntegration').mockResolvedValue({
    id: 'test-integration', name: 'Test account', providerIdentifier: 'tiktok', disabled: false,
  });
  vi.spyOn(PostizClient.prototype, 'createPost').mockResolvedValue({
    postId: 'remote-post', url: 'https://example.com/posts/remote-post', scheduledDate: new Date().toISOString(),
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch is forbidden in unit tests'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('publication state across real pipeline functions', () => {
  it('retries a known pre-upload failure but never reuses it to retry a later ambiguous throw', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, _ms, ...args) => schedule(callback, 0, ...args));
    vi.mocked(ffprobe.probeDurationSec).mockResolvedValueOnce(60).mockRejectedValue(new Error('network timeout'));
    vi.mocked(SlideVideoBuilder.prototype.build).mockRejectedValueOnce(new Error('503 temporary render failure'));
    const report = await new Orchestrator().publish({ contentSlug: slug, platforms: ['instagram'] });
    expect(report.results[0]).toMatchObject({ success: false, outcome: 'unknown', error: 'network timeout' });
    expect(ffprobe.probeDurationSec).toHaveBeenCalledTimes(2);
    expect(SlideVideoBuilder.prototype.build).toHaveBeenCalledOnce();
    expect(PostizClient.prototype.createPost).not.toHaveBeenCalled();
  });

  it.each([
    ['render.tiktok', { outcome: 'published', postId: 'confirmed' }, false, false],
    ['publishXtiktok', { outcome: 'published', postId: 'confirmed' }, false, false],
    ['publish.tiktok', { platform: 'x', outcome: 'published', postId: 'confirmed' }, false, false],
    ['publish.tiktok.skipped', { skipped: true }, false, false],
    ['publish.tiktok.part1', part(1, 2, 'published'), false, true],
    ['publish.tiktok', part(1, 2, 'published'), false, true],
    ['publish.tiktok', { postId: 'legacy-accepted' }, false, true],
    ['publish.tiktok', {}, false, true],
    ['publish.tiktok.part1', { url: 'file:///preview.mp4' }, false, false],
    ['publish.tiktok', { outcome: 'published', postId: 'confirmed' }, true, false],
  ] as const)('classifies action/platform/part identity through the disk log: %s %j', async (action, raw, published, held) => {
    const log = new DecisionLog();
    await log.record({ action, contentSlug: slug, platform: 'tiktok', reason: 'test',
      result: { platform: 'tiktok', success: true, timestamp: new Date().toISOString(), ...raw } as PublishResult });
    const history = log.list();
    expect(wasRecentlyPublished(history, slug, 'tiktok').recent).toBe(published);
    expect(Boolean(findPublicationHold(history, slug, 'tiktok'))).toBe(held);
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['tiktok'])).toBe(published || held ? null : slug);
  });

  it.each([
    { parts: [] }, { parts: [part(1)] }, { parts: [part(1), part(1)] }, { parts: [part(0), part(2)] },
    { parts: [part(1), part(2, 3)] }, { parts: [part(1), { ...part(2), platform: 'x' as const }] },
  ])('does not complete an incomplete or contradictory multipart result: %j', ({ parts }) => {
    const result = normalizePublishResult({ platform: 'tiktok', success: true, parts, timestamp: new Date().toISOString() });
    expect(result).toMatchObject({ success: false, outcome: 'incomplete' });
    expect(result.parts?.map(p => p.postId)).toEqual(parts.map(p => p.postId));
  });

  it.each(['accepted', 'published'] as const)('completes all multipart facts as %s only with every part present', async outcome => {
    const log = new DecisionLog();
    const result = normalizePublishResult({ platform: 'tiktok', success: true, parts: [part(1, 2, outcome), part(2, 2, outcome)], timestamp: new Date().toISOString() });
    expect(result).toMatchObject({ success: true, outcome });
    await log.record({ action: 'publish.tiktok', contentSlug: slug, platform: 'tiktok', reason: 'test', result });
    expect(wasRecentlyPublished(log.list(), slug, 'tiktok').recent).toBe(outcome === 'published');
  });

  it('keeps old accepted work held without starving another candidate', async () => {
    const log = new DecisionLog();
    const entry = await log.record({ action: 'publish.tiktok', contentSlug: slug, platform: 'tiktok', reason: 'test',
      result: { platform: 'tiktok', success: true, postId: 'queued', timestamp: '2020-01-01T00:00:00Z' } });
    writeFileSync(join(root, 'data', 'decisions.jsonl'), JSON.stringify({ ...entry, storySlug: slug, contentSlug: undefined, createdAt: '2020-01-01T00:00:00Z' }) + '\n');
    const history = log.list();
    expect(history[0].contentSlug).toBe(slug);
    expect(wasRecentlyPublished(history, slug, 'tiktok').recent).toBe(false);
    expect(findPublicationHold(history, slug, 'tiktok')?.result.postId).toBe('queued');
    expect(selectNextContent([{ slug, generatedAtMs: 0 }, { slug: 'next-item', generatedAtMs: 1 }], history, ['tiktok'])).toBe('next-item');
  });

  it('reports an uncaught publisher error as unknown and never automatically retries it', async () => {
    vi.mocked(ffprobe.probeDurationSec).mockRejectedValue(new Error('network timeout'));
    const report = await new Orchestrator().publish({ contentSlug: slug, platforms: ['instagram'] });
    expect(report.results[0]).toMatchObject({ success: false, outcome: 'unknown', error: 'network timeout' });
    expect(ffprobe.probeDurationSec).toHaveBeenCalledOnce();
    expect(findPublicationHold(new DecisionLog().list(), slug, 'instagram')).toBeDefined();
  });

  it.each([
    { success: true, error: 'conflicting completion', parts: [part(1), part(2)] },
    { success: false, postId: 'retained-parent-id', parts: [{ ...part(1), success: false, postId: undefined, outcome: 'failed' as const }, { ...part(2), success: false, postId: undefined, outcome: 'failed' as const }] },
  ])('holds contradictory aggregate evidence instead of declaring completion or a safe retry: %j', raw => {
    const result = normalizePublishResult({ platform: 'tiktok', timestamp: new Date().toISOString(), ...raw });
    expect(result).toMatchObject({ success: false, outcome: 'incomplete' });
  });

  it.each(['unknown', 'incomplete', 'failed'] as const)('does not override an explicit %s multipart outcome with accepted', outcome => {
    const raw: PublishResult = {
      platform: 'tiktok', success: true, outcome, timestamp: new Date().toISOString(),
      parts: [{ platform: 'tiktok', success: true, postId: 'retained-id', partIndex: 1, partTotal: 1, timestamp: new Date().toISOString() }],
    };
    const result = normalizePublishResult(raw);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(outcome === 'failed' ? 'incomplete' : outcome);
    expect(result.parts?.[0].postId).toBe('retained-id');
  });

  it.each([
    { success: false, error: '503 network timeout' },
    { success: 'true', outcome: 'published', postId: 'retained-id' },
  ])('holds ambiguous legacy results without claiming publication: %j', async raw => {
    const log = new DecisionLog();
    await log.record({ action: 'publish.tiktok', contentSlug: slug, platform: 'tiktok', reason: 'legacy',
      result: { platform: 'tiktok', timestamp: new Date().toISOString(), ...raw } as PublishResult });
    const history = log.list();
    expect(isPublishedDecision(history[0])).toBe(false);
    expect(findPublicationHold(history, slug, 'tiktok')).toBeDefined();
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['tiktok'])).toBeNull();
  });

  it('does not count the RSS no-op as an accepted remote post', async () => {
    const report = await new Orchestrator().publish({ contentSlug: slug, platforms: ['spotify'] });
    expect(report.results[0]).toMatchObject({ outcome: 'skipped', skipped: true, reason: 'rss-only' });
    expect(wasRecentlyPublished(new DecisionLog().list(), slug, 'spotify').recent).toBe(false);
  });

  it('records multipart previews as render events including a whole-operation summary', async () => {
    vi.mocked(ffprobe.probeDurationSec).mockResolvedValue(240);
    const report = await new Orchestrator().publish({ contentSlug: slug, platforms: ['instagram'], dryRun: true });
    expect(report.results[0]).toMatchObject({ success: true, outcome: 'preview', preview: true, dryRun: true });
    expect(report.results[0].parts).toHaveLength(2);
    for (const part of report.results[0].parts!) {
      expect(part).toMatchObject({ outcome: 'preview', preview: true, dryRun: true });
    }
    expect(new DecisionLog().list().map(e => e.action)).toEqual([
      'render.instagram.part1', 'render.instagram.part2', 'render.instagram',
    ]);
    expect(PostizClient.prototype.createPost).not.toHaveBeenCalled();
  });

  it('retains accepted multipart IDs and holds an incomplete submission instead of retrying it', async () => {
    vi.mocked(ffprobe.probeDurationSec).mockResolvedValue(240);
    vi.mocked(PostizClient.prototype.createPost)
      .mockResolvedValueOnce({ postId: 'accepted-part-1', scheduledDate: new Date().toISOString() })
      .mockRejectedValue(new Error('503 network timeout'));
    const orchestrator = new Orchestrator();
    const report = await orchestrator.publish({ contentSlug: slug, platforms: ['instagram'] });
    expect(report.results[0]).toMatchObject({ success: false, outcome: 'incomplete' });
    expect(report.results[0].parts?.[0]).toMatchObject({ outcome: 'accepted', postId: 'accepted-part-1' });
    expect(PostizClient.prototype.createPost).toHaveBeenCalledTimes(2);
    const history = new DecisionLog().list();
    expect(history.map(e => e.action)).toEqual(['publish.instagram.part1', 'publish.instagram.part2', 'publish.instagram']);
    expect(history[2].result.parts?.[0].postId).toBe('accepted-part-1');
    expect(wasRecentlyPublished(history, slug, 'instagram').recent).toBe(false);
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['instagram'])).toBeNull();
    const held = await orchestrator.publish({ contentSlug: slug, platforms: ['instagram'] });
    expect(held.results[0]).toMatchObject({ outcome: 'skipped', reason: 'publication requires reconciliation' });
    expect(held.results[0].parts?.[0].postId).toBe('accepted-part-1');
    expect(PostizClient.prototype.createPost).toHaveBeenCalledTimes(2);
  }, 15000);

  it.each([
    [{}, 'unknown', false],
    [{ success: false, postId: 'retained-id', error: 'timeout' }, 'unknown', false],
    [{ outcome: 'unknown', postId: 'retained-id' }, 'unknown', false],
    [{ error: '503 network timeout', postId: 'retained-id' }, 'unknown', false],
    [{ outcome: 'failed', postId: 'retained-id' }, 'unknown', false],
    [{ outcome: 'published' }, 'unknown', false],
    [{ platform: 'x', postId: 'retained-id' }, 'unknown', false],
    [{ postId: '   ', url: 'rss://feed' }, 'unknown', false],
    [{ postId: 'accepted-id' }, 'accepted', true],
    [{ outcome: 'published', postId: 'confirmed-id' }, 'published', true],
    [{ success: false, outcome: 'failed', error: 'invalid input' }, 'failed', false],
  ] as const)('classifies the real base upload result without inventing success: %j', async (raw, outcome, success) => {
    const publisher = new BoundaryPublisher();
    publisher.upload.mockResolvedValue(raw);
    const result = await publisher.publish(context());
    expect(result).toMatchObject({ platform: 'tiktok', outcome, success });
    if ('postId' in raw) expect(result.postId).toBe(raw.postId);
    expect(publisher.upload).toHaveBeenCalledOnce();
  });

  it('does not turn an upload transport exception into a retryable known failure', async () => {
    const publisher = new BoundaryPublisher();
    publisher.upload.mockRejectedValue(new Error('network timeout after request'));
    const result = await publisher.publish(context());
    expect(result).toMatchObject({ success: false, outcome: 'unknown', error: 'network timeout after request' });
  });

  it.each<Partial<PublishResult>>([
    { url: 'file:///preview.mp4' },
    { url: ' FILE:///preview.mp4' },
    { preview: true, postId: 'misleading-id' },
    { dryRun: true, postId: 'misleading-id' },
    { outcome: 'preview', postId: 'misleading-id' },
  ])('does not consume a legacy preview as publication: %j', async markers => {
    const log = new DecisionLog();
    await log.record({
      action: 'publish.tiktok', contentSlug: slug, platform: 'tiktok', reason: 'legacy entry',
      result: { platform: 'tiktok', success: true, timestamp: new Date().toISOString(), ...markers },
    });
    const history = log.list();
    expect(wasRecentlyPublished(history, slug, 'tiktok').recent).toBe(false);
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['tiktok'])).toBe(slug);
  });

  it('reports previews explicitly and keeps them eligible for dispatch', async () => {
    const preview = await new Orchestrator().publish({ ...options, platforms: [...options.platforms], dryRun: true });
    expect(preview.results[0]).toMatchObject({ success: true, outcome: 'preview', preview: true, dryRun: true });
    expect(preview.results[0].url).toMatch(/^file:\/\//);
    const history = new DecisionLog().list();
    expect(history[0].action).toBe('render.tiktok');
    expect(wasRecentlyPublished(history, slug, 'tiktok').recent).toBe(false);
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['tiktok'])).toBe(slug);
  });

  it('allows a real publish after a preview instead of skipping it', async () => {
    const orchestrator = new Orchestrator();
    const preview = await orchestrator.publish({ ...options, platforms: [...options.platforms], dryRun: true });
    expect(preview.results[0].success).toBe(true);
    expect(PostizClient.prototype.createPost).not.toHaveBeenCalled();

    const published = await orchestrator.publish({ ...options, platforms: [...options.platforms] });
    expect(published.results[0].skipped).not.toBe(true);
    expect(PostizClient.prototype.createPost).toHaveBeenCalledOnce();
    expect(published.results[0]).toMatchObject({ success: true, outcome: 'accepted', postId: 'remote-post' });

    const history = new DecisionLog().list();
    expect(wasRecentlyPublished(history, slug, 'tiktok').recent).toBe(false);
    expect(selectNextContent([{ slug, generatedAtMs: 0 }], history, ['tiktok'])).toBeNull();

    const held = await orchestrator.publish({ ...options, platforms: [...options.platforms] });
    expect(held.results[0]).toMatchObject({
      success: true, skipped: true, outcome: 'skipped', reason: 'publication requires reconciliation', postId: 'remote-post',
    });
    expect(PostizClient.prototype.createPost).toHaveBeenCalledOnce();
  });
});
