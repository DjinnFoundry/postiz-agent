import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YoutubeAdapter } from '../../src/platforms/youtube.js';
import { YoutubePublisher } from '../../src/platforms/youtube-publisher.js';
import { run } from '../../src/lib/process.js';

vi.mock('../../src/lib/process.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/lib/process.js')>(), run: vi.fn() }));
let root: string;
const localId = 'e0634f03-88d8-40b9-b630-b6a1a48f8d30';
const registered = `Video registered without STT.\nVideo ID:   ${localId}\nTitle:      Sample\nPath:       /tmp/sample.mp4\nSTT:        not run\n`;
const uploaded = `Upload: uploaded\n  Video ID: ${localId}\n  YouTube ID: Abcde123_-Z\n  URL: https://www.youtube.com/watch?v=Abcde123_-Z\n`;
const input = () => ({ videoPath: join(root, 'sample.mp4'), title: 'Sample', description: 'Description', privacy: 'unlisted' as const, categoryId: '27' });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'youtube-contract-'));
  writeFileSync(join(root, 'sample.mp4'), 'video');
  writeFileSync(join(root, 'youtube_cli'), 'mock escript');
  vi.mocked(run).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('YoutubeCLI adapter contract', () => {
  it('registers a file and uploads the returned UUID using the actual escript syntax', async () => {
    vi.mocked(run).mockResolvedValueOnce({ stdout: registered, stderr: '' }).mockResolvedValueOnce({ stdout: uploaded, stderr: '' });
    const result = await new YoutubeAdapter(root, 'tenant-channel').upload(input());
    expect(result).toEqual({ videoId: 'Abcde123_-Z', url: 'https://www.youtube.com/watch?v=Abcde123_-Z' });
    expect(run).toHaveBeenNthCalledWith(1, join(root, 'youtube_cli'), ['video', 'register', input().videoPath, '--channel', 'tenant-channel'], { cwd: root });
    expect(run).toHaveBeenNthCalledWith(2, join(root, 'youtube_cli'), ['video', 'upload', localId, '--title', 'Sample', '--description', 'Description', '--privacy', 'unlisted', '--category', '27', '--channel', 'tenant-channel'], { cwd: root });
  });
  it('does not upload if registration output lacks a valid local UUID', async () => {
    vi.mocked(run).mockResolvedValue({ stdout: 'Video ID: invalid', stderr: '' });
    await expect(new YoutubeAdapter(root).upload(input())).rejects.toThrow(/registration|register/i);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout', 'bad-output'])('marks %s during upload as uncertain so an automatic retry cannot duplicate it', async mode => {
    vi.mocked(run).mockResolvedValueOnce({ stdout: registered, stderr: '' });
    if (mode === 'timeout') vi.mocked(run).mockRejectedValueOnce(new Error('timed out after upload started'));
    else vi.mocked(run).mockResolvedValueOnce({ stdout: `Upload: uploaded\n  Video ID: ${localId}\n`, stderr: '' });
    await expect(new YoutubeAdapter(root).upload(input())).rejects.toMatchObject({ code: 'YOUTUBE_PUBLISH_UNCERTAIN' });
  });
  it('reports a missing escript before running any command', async () => {
    rmSync(join(root, 'youtube_cli'));
    await expect(new YoutubeAdapter(root).upload(input())).rejects.toThrow(/escript|youtube_cli/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('YouTube product tags', () => {
  it.each([undefined, { hashtags: ['product', 'launch'] }])('does not add children story tags to an existing product video', async brand => {
    const adapter = new YoutubeAdapter(root);
    const upload = vi.spyOn(adapter, 'upload').mockResolvedValue({ videoId: 'Abcde123_-Z', url: 'https://www.youtube.com/watch?v=Abcde123_-Z' });
    const result = await new YoutubePublisher(adapter).publish({ bundle: { id: 'product-launch', kind: 'video', primaryMedia: input().videoPath, text: { body: 'New product' }, locale: 'es', theme: { mood: 'fantasia' } }, workDir: root, words: [], brand });
    expect(result.success).toBe(true);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ tags: brand?.hashtags ?? [], privacy: 'unlisted' }));
  });
});
