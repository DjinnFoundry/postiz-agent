import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../../src/cli/doctor.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../../src/types.js';
import type { PostizIntegration } from '../../src/platforms/postiz.js';

const NOW = new Date('2026-04-22T12:00:00Z');

function mkFixtureDir(files: string[] = ['dragon-marcos.json']): string {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-fx-'));
  for (const f of files) writeFileSync(join(dir, f), '{"titulo":"x"}', 'utf-8');
  return dir;
}

function successEntry(slug: string, platform: Platform, hoursAgo: number): DecisionLogEntry {
  const ts = new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  return {
    id: `${slug}-${platform}-ok`,
    action: `publish.${platform}`,
    storySlug: slug,
    platform,
    reason: 'test',
    createdAt: ts,
    result: { platform, success: true, timestamp: ts },
  };
}

function failEntry(
  slug: string,
  platform: Platform,
  hoursAgo: number,
  errorClass: PublishResult['errorClass'] = 'permanent',
  remediationAction = 'manual-review',
  remediationHint = 'Postiz rejected the payload',
): DecisionLogEntry {
  const ts = new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  return {
    id: `${slug}-${platform}-${hoursAgo}-fail`,
    action: `publish.${platform}`,
    storySlug: slug,
    platform,
    reason: 'test',
    createdAt: ts,
    result: {
      platform,
      success: false,
      error: 'boom',
      errorClass,
      remediation: { action: remediationAction, humanHint: remediationHint },
      timestamp: ts,
    },
  };
}

describe('runDoctor', () => {
  it('returns sections and marks ok=true on a clean setup', async () => {
    const akDir = mkFixtureDir(['dragon-marcos.json']);
    try {
      const integrations: PostizIntegration[] = [
        { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
        { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
        { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
        { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
      ];
      const report = await runDoctor({
        now: NOW,
        decisions: [successEntry('dragon-marcos', 'x', 1)],
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => integrations,
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      expect(report.ok).toBe(true);
      const sections = report.sections.map(s => s.name);
      expect(sections).toEqual(expect.arrayContaining([
        'environment', 'postiz', 'audiokids', 'stuck-slugs', 'recent-failures', 'upload-cache', 'theme-decisions',
      ]));
      const postiz = report.sections.find(s => s.name === 'postiz')!;
      expect(postiz.items.every(i => i.status === 'ok')).toBe(true);
      const stuck = report.sections.find(s => s.name === 'stuck-slugs')!;
      expect(stuck.items).toHaveLength(1);
      expect(stuck.items[0].status).toBe('ok');
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('flags needs-config when POSTIZ_API_KEY is missing and sets ok=false', async () => {
    const akDir = mkFixtureDir();
    try {
      const report = await runDoctor({
        now: NOW,
        decisions: [],
        audiokidsDir: akDir,
        postizApiKey: '',
        listIntegrations: async () => { throw new Error('should not be called'); },
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      expect(report.ok).toBe(false);
      const postiz = report.sections.find(s => s.name === 'postiz')!;
      const needsConfig = postiz.items.find(i => i.status === 'needs-config');
      expect(needsConfig).toBeDefined();
      expect(needsConfig!.hint).toMatch(/POSTIZ_API_KEY/);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('flags disabled and missing Postiz integrations', async () => {
    const akDir = mkFixtureDir();
    try {
      const integrations: PostizIntegration[] = [
        { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
        { id: '2', name: 'TikTok (stale)', providerIdentifier: 'tiktok', disabled: true },
      ];
      const report = await runDoctor({
        now: NOW,
        decisions: [],
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => integrations,
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      const postiz = report.sections.find(s => s.name === 'postiz')!;
      const tiktok = postiz.items.find(i => i.label.includes('tiktok'))!;
      expect(tiktok.status).toBe('needs-config');
      const ig = postiz.items.find(i => i.label.includes('instagram'))!;
      expect(ig.status).toBe('needs-config');
      const yt = postiz.items.find(i => i.label.includes('youtube'))!;
      expect(yt.status).toBe('needs-config');
      expect(report.ok).toBe(false);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('marks audiokids warn when directory exists but is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
    try {
      const report = await runDoctor({
        now: NOW,
        decisions: [],
        audiokidsDir: dir,
        postizApiKey: 'present',
        listIntegrations: async () => [
          { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
          { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
          { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
          { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
        ],
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      const ak = report.sections.find(s => s.name === 'audiokids')!;
      const storyCount = ak.items.find(i => i.label.includes('stories'))!;
      expect(storyCount.status).toBe('warn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks audiokids missing=permanent when directory is absent', async () => {
    const missing = join(tmpdir(), 'doctor-absent-' + Math.random().toString(36).slice(2));
    const report = await runDoctor({
      now: NOW,
      decisions: [],
      audiokidsDir: missing,
      postizApiKey: 'present',
      listIntegrations: async () => [],
      uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
      themeDecisions: { count: 0, exists: false },
    });
    const ak = report.sections.find(s => s.name === 'audiokids')!;
    const dirItem = ak.items.find(i => i.label.includes('output dir'))!;
    expect(dirItem.status).toBe('permanent');
    expect(report.ok).toBe(false);
  });

  it('lists stuck slugs and sets ok=false when >0', async () => {
    const akDir = mkFixtureDir();
    try {
      // 3 permanent failures in 72h → stuck
      const decisions = [
        failEntry('dragon', 'tiktok', 50, 'permanent'),
        failEntry('dragon', 'tiktok', 20, 'permanent'),
        failEntry('dragon', 'tiktok', 2, 'permanent'),
      ];
      const report = await runDoctor({
        now: NOW,
        decisions,
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => [
          { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
          { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
          { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
          { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
        ],
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      const stuck = report.sections.find(s => s.name === 'stuck-slugs')!;
      expect(stuck.items.length).toBeGreaterThan(0);
      expect(stuck.items[0].status).toBe('permanent');
      expect(stuck.items[0].label).toMatch(/dragon/);
      expect(stuck.items[0].label).toMatch(/tiktok/);
      expect(report.ok).toBe(false);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('shows recent failures with remediation hints', async () => {
    const akDir = mkFixtureDir();
    try {
      const decisions = [
        failEntry('dragon', 'x', 2, 'permanent', 'manual-review', 'Postiz rejected the payload'),
        failEntry('unicorn', 'tiktok', 1, 'transient', 'retry', 'network hiccup'),
        successEntry('dragon', 'instagram', 3),
      ];
      const report = await runDoctor({
        now: NOW,
        decisions,
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => [
          { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
          { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
          { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
          { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
        ],
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
      });
      const recent = report.sections.find(s => s.name === 'recent-failures')!;
      const hints = recent.items.map(i => i.hint ?? '');
      expect(hints.some(h => /Postiz/.test(h))).toBe(true);
      expect(hints.some(h => /network/.test(h))).toBe(true);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('reports upload-cache and theme-decisions counts', async () => {
    const akDir = mkFixtureDir();
    try {
      const report = await runDoctor({
        now: NOW,
        decisions: [],
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => [
          { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
          { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
          { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
          { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
        ],
        uploadCache: { count: 12, oldestUploadedAt: '2026-04-10T00:00:00Z', exists: true },
        themeDecisions: { count: 5, exists: true },
      });
      const uc = report.sections.find(s => s.name === 'upload-cache')!;
      expect(uc.items.some(i => /12/.test(i.label))).toBe(true);
      const tm = report.sections.find(s => s.name === 'theme-decisions')!;
      expect(tm.items.some(i => /5/.test(i.label))).toBe(true);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });
});
