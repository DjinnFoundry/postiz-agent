import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AudioKidsAdapter } from '../../src/adapters/audiokids.js';
import { selectNextStory } from '../../src/dispatch.js';

const FIXTURES = resolve(__dirname, '..', 'fixtures');
const v1 = readFileSync(join(FIXTURES, 'audiokids-output', 'dragon-marcos.json'), 'utf-8');
const v2 = readFileSync(join(FIXTURES, 'audiokids-output-v2', 'mati-museo-sample-2026-05-01T10-00-00-000Z', 'story.json'), 'utf-8');

describe.each(['v1', 'v2'] as const)('AudioKids %s candidate validation', layout => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audiokids-candidates-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  function story(slug: string, metadata: string, mtime: number, audio: 'file' | 'empty' | 'directory' | 'missing' = 'file') {
    const storyDir = layout === 'v2' ? join(dir, slug) : dir;
    mkdirSync(storyDir, { recursive: true });
    const jsonPath = join(storyDir, layout === 'v2' ? 'story.json' : `${slug}.json`);
    const audioPath = join(storyDir, `${slug}.mp3`);
    writeFileSync(jsonPath, metadata);
    utimesSync(jsonPath, mtime, mtime);
    if (audio === 'directory') mkdirSync(audioPath);
    else if (audio !== 'missing') writeFileSync(audioPath, audio === 'empty' ? '' : 'ID3');
    return jsonPath;
  }

  it.each(['{', '{}'])('skips older invalid metadata %j so the next valid story can dispatch', malformed => {
    const badPath = story('bad-old', malformed, 1);
    story('good-new', layout === 'v1' ? v1 : v2, 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = new AudioKidsAdapter(dir);
    const candidates = adapter.listCandidates();
    const selected = selectNextStory(candidates.map(c => ({ slug: c.slug, generatedAtMs: c.mtimeMs })), [], ['x']);

    expect(selected).toBe('good-new');
    expect(candidates.map(c => c.slug)).toEqual(['good-new']);
    expect(adapter.loadBundle(selected!)).toHaveProperty('id', 'good-new');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad-old'));
    expect(readFileSync(badPath, 'utf-8')).toBe(malformed);
  });

  it.each(['missing', 'empty', 'directory'] as const)('skips %s audio and reports the candidate without generating assets', audio => {
    story('bad-audio', layout === 'v1' ? v1 : v2, 1, audio);
    const warnings: string[] = [];
    const adapter = new AudioKidsAdapter(dir, { onWarn: warning => warnings.push(warning), generatePlaceholder: true, placeholderDir: join(dir, 'covers') });

    expect(adapter.listCandidates()).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('bad-audio')]);
    expect(existsSync(join(dir, 'covers'))).toBe(false);
  });
});

describe('AudioKids overlapping layouts', () => {
  it('does not advertise a v1 fallback that loadBundle would shadow with corrupt v2 metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-overlap-'));
    const warnings: string[] = [];
    try {
      for (const slug of ['bad-old', 'good-new']) {
        writeFileSync(join(dir, `${slug}.json`), v1);
        writeFileSync(join(dir, `${slug}.mp3`), 'ID3');
      }
      mkdirSync(join(dir, 'bad-old'));
      writeFileSync(join(dir, 'bad-old', 'story.json'), '{');
      writeFileSync(join(dir, 'bad-old', 'bad-old.mp3'), 'ID3');
      const adapter = new AudioKidsAdapter(dir, { onWarn: warning => warnings.push(warning) });

      expect(adapter.listCandidates().map(c => c.slug)).toEqual(['good-new']);
      expect(warnings).toEqual([expect.stringContaining('bad-old')]);
      expect(adapter.loadBundle('good-new')).toHaveProperty('id', 'good-new');
      expect(existsSync(join(dir, 'bad-old.json'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
