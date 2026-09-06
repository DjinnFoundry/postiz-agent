import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstagramPublisher } from '../../src/platforms/instagram-publisher.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { DecisionLog } from '../../src/decisions/log.js';
import type { PostizClient, CreatePostInput } from '../../src/platforms/postiz.js';
import type { SlideVideoBuilder } from '../../src/media/slide-video.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { PublishResult } from '../../src/types.js';

const bundle: ContentBundle = { id: 'story', kind: 'audio-story', primaryMedia: '/story.mp3', locale: 'es', text: { body: 'Una aventura larga.' } };

describe('Instagram publication recovery', () => {
  let dir: string;
  let log: DecisionLog;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ig-recovery-')); log = new DecisionLog(join(dir, 'decisions.jsonl')); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function publisher(createPost: (input: CreatePostInput) => Promise<unknown>, build?: () => void) {
    const client = { findIntegration: async () => ({ id: 'ig', providerIdentifier: 'instagram-standalone' }), createPost } as unknown as PostizClient;
    const slides = { build: async ({ outputPath }: { outputPath: string }) => { build?.(); return { outputPath, warnings: [] }; } } as unknown as SlideVideoBuilder;
    return new InstagramPublisher(client, async () => 240, slides);
  }

  it('persists each part and resumes only the missing part on a later run', async () => {
    let failSecond = true;
    const sent: string[] = [];
    const pub = publisher(async input => {
      sent.push(input.text);
      if (input.text.includes('Parte 2 de 2')) {
        expect(log.list().some(e => e.result.partIndex === 1 && e.result.success)).toBe(true);
        if (failSecond) throw new Error('Postiz 400 invalid caption');
      }
      return { postId: `post-${sent.length}`, scheduledDate: input.scheduledDate };
    });
    const orch = new Orchestrator({ decisions: log, workDir: dir, alertWebhookUrl: '', getPublisher: () => pub, preflight: async () => ({ ok: true }) });
    const first = await orch.publish({ bundle, platforms: ['instagram'], skipTranscription: true });
    expect(first.results[0].success).toBe(false);
    failSecond = false;
    const second = await orch.publish({ bundle, platforms: ['instagram'], skipTranscription: true });
    expect(second.results[0].success).toBe(true);
    expect(sent.filter(text => text.includes('Parte 1 de 2'))).toHaveLength(1);
    expect(sent.filter(text => text.includes('Parte 2 de 2'))).toHaveLength(2);
  });

  it('stops after a failed part so later parts cannot publish out of order', async () => {
    const createPost = vi.fn(async () => { throw new Error('Postiz 400 invalid caption'); });
    const result = await publisher(createPost).publish({ bundle, words: [], workDir: dir });
    expect(result.success).toBe(false);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('schedules after rendering and preserves spacing when resuming', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-09-06T10:00:00Z');
    vi.setSystemTime(start);
    const previous: PublishResult = { platform: 'instagram', success: true, postId: 'first', partIndex: 1, partTotal: 2, timestamp: new Date(start).toISOString(), scheduledDate: new Date(start + 20 * 60_000).toISOString() };
    const sent: CreatePostInput[] = [];
    const pub = publisher(async input => {
      sent.push(input);
      expect(Date.parse(input.scheduledDate!)).toBeGreaterThanOrEqual(Date.now());
      return { postId: 'second', scheduledDate: input.scheduledDate };
    }, () => vi.setSystemTime(Date.now() + 10 * 60_000));
    await pub.publish({ bundle, words: [], workDir: dir, completedParts: [previous] });
    expect(sent).toHaveLength(1);
    expect(Date.parse(sent[0].scheduledDate!)).toBeGreaterThanOrEqual(start + 25 * 60_000);
    expect(sent[0]).toHaveProperty('providerIdentifier', 'instagram-standalone');
  });
});
