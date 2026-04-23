import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStatus, formatStatusReport } from '../../src/cli/status.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../../src/types.js';
import type { PostizIntegration } from '../../src/platforms/postiz.js';

const NOW = new Date('2026-04-22T12:00:00Z');

function mkFixtureDir(files: string[] = ['dragon-marcos.json']): string {
  const dir = mkdtempSync(join(tmpdir(), 'status-fx-'));
  for (const f of files) writeFileSync(join(dir, f), '{"titulo":"x"}', 'utf-8');
  return dir;
}

function successEntry(slug: string, platform: Platform, hoursAgo: number): DecisionLogEntry {
  const ts = new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  return {
    id: `${slug}-${platform}-ok-${hoursAgo}`,
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
      remediation: { action: 'manual-review', humanHint: 'fix it' },
      timestamp: ts,
    },
  };
}

const BASE_INTEGRATIONS: PostizIntegration[] = [
  { id: '1', name: 'X', providerIdentifier: 'x', disabled: false },
  { id: '2', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
  { id: '3', name: 'IG', providerIdentifier: 'instagram', disabled: false },
  { id: '4', name: 'YT', providerIdentifier: 'youtube', disabled: false },
];

describe('runStatus (enriched)', () => {
  it('returns deps + system panel with counts from injected deps', async () => {
    const akDir = mkFixtureDir();
    try {
      const report = await runStatus({
        now: NOW,
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => BASE_INTEGRATIONS,
        decisions: [
          successEntry('dragon-marcos', 'x', 1),
          successEntry('dragon-marcos', 'tiktok', 2),
          failEntry('unicorn', 'instagram', 5, 'transient'),
        ],
        toolNames: ['transcribe', 'moderate-captions', 'render-slide-video'],
        treatmentIds: ['hero-display', 'midnight', 'terminal-crt'],
        uploadCache: { count: 7, oldestUploadedAt: '2026-04-10T00:00:00Z', exists: true },
        themeDecisions: { count: 4, exists: true },
        binChecks: async () => [
          { label: 'ffmpeg installed', ok: true, required: true },
          { label: 'whisper installed', ok: true, required: false },
        ],
      });

      expect(report.generatedAt).toBe(NOW.toISOString());
      expect(Array.isArray(report.deps)).toBe(true);
      expect(report.deps.some(d => d.label === 'ffmpeg installed')).toBe(true);
      expect(report.deps.some(d => d.label === 'AudioKids output dir')).toBe(true);

      expect(report.system.tools).toBe(3);
      expect(report.system.treatments).toBe(3);
      expect(report.system.decisions).toBe(3);
      expect(report.system.themeDecisions).toBe(4);
      expect(report.system.uploads.count).toBe(7);
      expect(report.system.uploads.oldestUploadedAt).toBe('2026-04-10T00:00:00Z');
      expect(report.system.stuckSlugs).toBe(0);
      expect(report.system.successRate7d.success).toBe(2);
      expect(report.system.successRate7d.failed).toBe(1);
      expect(report.system.successRate7d.rate).toBeCloseTo(2 / 3, 4);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('counts stuck slugs via findStuckSlugs over injected decisions', async () => {
    const akDir = mkFixtureDir();
    try {
      const decisions = [
        failEntry('dragon', 'tiktok', 50, 'permanent'),
        failEntry('dragon', 'tiktok', 20, 'permanent'),
        failEntry('dragon', 'tiktok', 2, 'permanent'),
      ];
      const report = await runStatus({
        now: NOW,
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => BASE_INTEGRATIONS,
        decisions,
        toolNames: [],
        treatmentIds: [],
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
        binChecks: async () => [],
      });
      expect(report.system.stuckSlugs).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('handles empty cache/themeDecisions gracefully', async () => {
    const akDir = mkFixtureDir();
    try {
      const report = await runStatus({
        now: NOW,
        audiokidsDir: akDir,
        postizApiKey: '',
        listIntegrations: async () => { throw new Error('should not call'); },
        decisions: [],
        toolNames: [],
        treatmentIds: [],
        uploadCache: { count: 0, oldestUploadedAt: null, exists: false },
        themeDecisions: { count: 0, exists: false },
        binChecks: async () => [],
      });
      expect(report.system.uploads.count).toBe(0);
      expect(report.system.uploads.oldestUploadedAt).toBeNull();
      expect(report.system.themeDecisions).toBe(0);
      expect(report.system.decisions).toBe(0);
      expect(report.system.successRate7d.success).toBe(0);
      expect(report.system.successRate7d.failed).toBe(0);
      expect(report.system.successRate7d.rate).toBe(0);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });

  it('formatStatusReport (human) renders deps section and system section', async () => {
    const akDir = mkFixtureDir();
    try {
      const report = await runStatus({
        now: NOW,
        audiokidsDir: akDir,
        postizApiKey: 'present',
        listIntegrations: async () => BASE_INTEGRATIONS,
        decisions: [successEntry('dragon-marcos', 'x', 1)],
        toolNames: ['transcribe'],
        treatmentIds: ['hero-display'],
        uploadCache: { count: 2, oldestUploadedAt: '2026-04-01T00:00:00Z', exists: true },
        themeDecisions: { count: 1, exists: true },
        binChecks: async () => [
          { label: 'ffmpeg installed', ok: true, required: true },
        ],
      });

      const text = formatStatusReport(report, 'human');
      expect(text).toMatch(/── deps ──/);
      expect(text).toMatch(/── system ──/);
      expect(text).toMatch(/tools:\s*1/);
      expect(text).toMatch(/treatments:\s*1/);
      expect(text).toMatch(/decisions:\s*1/);
      expect(text).toMatch(/uploads:\s*2/);
      expect(text).toMatch(/theme decisions:\s*1/);

      const jsonStr = formatStatusReport(report, 'json');
      const parsed = JSON.parse(jsonStr);
      expect(parsed.system.tools).toBe(1);
      expect(parsed.system.treatments).toBe(1);
    } finally {
      rmSync(akDir, { recursive: true, force: true });
    }
  });
});
