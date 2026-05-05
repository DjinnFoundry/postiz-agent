import { existsSync } from 'node:fs';
import { findStuckSlugs } from '../dispatch.js';
import { DecisionLog } from '../decisions/log.js';
import { UploadCache } from '../lib/upload-cache.js';
import { ThemeDecisionStore } from '../theme/catalog.js';
import { PostizClient, probePostizIntegrations, type PostizIntegration } from '../platforms/postiz.js';
import { AudioKidsAdapter } from '../adapters/audiokids.js';
import { config } from '../config.js';
import type { DecisionLogEntry, Platform } from '../types.js';

// Status tokens mirror ClassifiedError kinds plus ok/warn, so human renderers and
// JSON consumers share the same enum the error classifier already produces.
export type DoctorStatus = 'ok' | 'warn' | 'transient' | 'permanent' | 'needs-config' | 'needs-human' | 'unknown';

export interface DoctorItem {
  label: string;
  status: DoctorStatus;
  hint?: string;
}

export interface DoctorSection {
  name: string;
  items: DoctorItem[];
}

export interface DoctorReport {
  generatedAt: string;
  ok: boolean;
  sections: DoctorSection[];
}

const POSTIZ_TARGET_PLATFORMS: Array<'x'|'tiktok'|'instagram'|'youtube'> = ['x', 'tiktok', 'instagram', 'youtube'];

// Warn is intentionally excluded: warnings are visible but non-blocking.
const BLOCKING_STATUSES: DoctorStatus[] = ['permanent', 'needs-config', 'needs-human'];

export interface DoctorInput {
  now?: Date;
  decisions?: DecisionLogEntry[];
  audiokidsDir?: string;
  postizApiKey?: string;
  listIntegrations?: () => Promise<PostizIntegration[]>;
  uploadCache?: { count: number; oldestUploadedAt: string | null; exists: boolean };
  themeDecisions?: { count: number; exists: boolean };
}

// Every dependency is injectable so unit tests avoid disk + network while the
// CLI binds the real DecisionLog, PostizClient, and config-derived paths.
export async function runDoctor(input: DoctorInput = {}): Promise<DoctorReport> {
  const now = input.now ?? new Date();
  const decisions = input.decisions ?? new DecisionLog().list();
  const audiokidsDir = input.audiokidsDir ?? config.audiokids.outputDir;
  const postizApiKey = input.postizApiKey ?? config.postiz.apiKey;
  const listIntegrations = input.listIntegrations ?? (() => new PostizClient().listIntegrations());
  const uploadCache = input.uploadCache ?? new UploadCache().summarize();
  const themeDecisions = input.themeDecisions ?? new ThemeDecisionStore().summarize();

  const sections: DoctorSection[] = [];

  sections.push({
    name: 'environment',
    items: [
      boolItem('POSTIZ_API_KEY set', Boolean(postizApiKey), 'needs-config', 'POSTIZ_API_KEY missing from .env'),
      boolItem('YouTubeCLI project path exists', existsSync(config.youtubecli.path), 'warn', `not found at ${config.youtubecli.path}`),
    ],
  });

  sections.push({ name: 'postiz', items: await buildPostizSection(postizApiKey, listIntegrations) });
  sections.push({ name: 'audiokids', items: buildAudiokidsSection(audiokidsDir) });
  sections.push({ name: 'stuck-slugs', items: buildStuckSection(decisions, now) });
  sections.push({ name: 'recent-failures', items: buildRecentFailuresSection(decisions) });
  sections.push({ name: 'upload-cache', items: buildUploadCacheSection(uploadCache) });
  sections.push({ name: 'theme-decisions', items: buildThemeDecisionsSection(themeDecisions) });

  const ok = !sections.some(s => s.items.some(i => BLOCKING_STATUSES.includes(i.status)));
  return { generatedAt: now.toISOString(), ok, sections };
}

function boolItem(label: string, ok: boolean, failStatus: DoctorStatus, failHint: string): DoctorItem {
  return ok ? { label, status: 'ok' } : { label, status: failStatus, hint: failHint };
}

async function buildPostizSection(
  apiKey: string,
  listIntegrations: () => Promise<PostizIntegration[]>,
): Promise<DoctorItem[]> {
  const probe = await probePostizIntegrations(apiKey, listIntegrations);
  if (probe.kind === 'no-api-key') {
    return [{
      label: 'postiz integrations',
      status: 'needs-config',
      hint: 'POSTIZ_API_KEY missing; set it in .env so the agent can reach Postiz',
    }];
  }
  if (probe.kind === 'unreachable') {
    return [{
      label: 'postiz integrations',
      status: 'needs-config',
      hint: `could not query Postiz: ${probe.message}`,
    }];
  }
  const items: DoctorItem[] = [];
  for (const platform of POSTIZ_TARGET_PLATFORMS) {
    const status = probe.perPlatform[platform];
    if (!status || status.state === 'missing') {
      items.push({
        label: `${platform} integration`,
        status: 'needs-config',
        hint: `not connected; connect at ${probe.reconnectUrl}`,
      });
    } else if (status.state === 'disabled') {
      items.push({
        label: `${platform} integration`,
        status: 'needs-config',
        hint: `${status.name} disabled; reconnect at ${probe.reconnectUrl}`,
      });
    } else {
      items.push({ label: `${platform} integration (${status.name})`, status: 'ok' });
    }
  }
  return items;
}

function buildAudiokidsSection(audiokidsDir: string): DoctorItem[] {
  const items: DoctorItem[] = [];
  if (!existsSync(audiokidsDir)) {
    items.push({
      label: `output dir exists (${audiokidsDir})`,
      status: 'permanent',
      hint: 'AUDIOKIDS_OUTPUT_DIR does not point to an existing directory',
    });
    return items;
  }
  items.push({ label: `output dir exists (${audiokidsDir})`, status: 'ok' });
  // Defer to the adapter so v1 (flat <slug>.json+.mp3) AND v2 (subdir/story.json)
  // candidates both count. Replacing this with a flat readdir walk is what made
  // dr go "0 stories" right after the AudioKids upstream switched to subdirs.
  let storyCount = 0;
  try {
    storyCount = new AudioKidsAdapter(audiokidsDir).listCandidates().length;
  } catch {
    storyCount = 0;
  }
  if (storyCount === 0) {
    items.push({
      label: 'stories present (0)',
      status: 'warn',
      hint: 'no AudioKids stories in the output dir; run AudioKids generation first',
    });
  } else {
    items.push({ label: `stories present (${storyCount})`, status: 'ok' });
  }
  return items;
}

function buildStuckSection(decisions: DecisionLogEntry[], now: Date): DoctorItem[] {
  const platforms: Platform[] = ['x', 'tiktok', 'instagram', 'youtube'];
  const stuck = findStuckSlugs(decisions, platforms, now);
  if (stuck.length === 0) return [{ label: 'no slugs stuck', status: 'ok' }];
  return stuck.map(s => ({
    label: `${s.slug} · ${s.platform} · ${s.reason}`,
    status: s.reason === 'within-transient-backoff' ? 'transient' : 'permanent',
    hint: s.lastRemediation?.humanHint ?? (s.nextEligibleAt ? `eligible again at ${s.nextEligibleAt}` : undefined),
  }));
}

function buildRecentFailuresSection(decisions: DecisionLogEntry[]): DoctorItem[] {
  const failures = decisions
    .filter(d => d.result && !d.result.success && !d.result.skipped)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
  if (failures.length === 0) return [{ label: 'no recent failures', status: 'ok' }];
  return failures.map(f => ({
    label: `${f.storySlug} · ${f.platform} · ${f.result.errorClass ?? 'unknown'}`,
    status: f.result.errorClass ?? 'unknown',
    hint: f.result.remediation?.humanHint ?? f.result.error,
  }));
}

function buildUploadCacheSection(uc: { count: number; oldestUploadedAt: string | null; exists: boolean }): DoctorItem[] {
  if (!uc.exists) return [{ label: 'upload cache: not yet created', status: 'ok' }];
  const items: DoctorItem[] = [{ label: `upload cache: ${uc.count} entries`, status: 'ok' }];
  if (uc.oldestUploadedAt) {
    items.push({ label: `oldest entry: ${uc.oldestUploadedAt}`, status: 'ok' });
  }
  return items;
}

function buildThemeDecisionsSection(tm: { count: number; exists: boolean }): DoctorItem[] {
  if (!tm.exists) return [{ label: 'theme decisions: not yet created', status: 'ok' }];
  return [{ label: `theme decisions: ${tm.count} bundle(s) cached`, status: 'ok' }];
}

// No colors so output survives tee / cron mail / webhook bodies.
export function formatDoctorReport(report: DoctorReport): string {
  const out: string[] = [];
  for (const section of report.sections) {
    out.push(`── ${section.name} ──`);
    for (const item of section.items) {
      const mark = item.status === 'ok' ? '✓' : item.status === 'warn' ? '⚠' : '✗';
      const hint = item.hint ? `  ${item.hint}` : '';
      out.push(`  ${mark} ${item.label}${item.status === 'ok' ? '' : ` [${item.status}]`}${hint}`);
    }
    out.push('');
  }
  out.push(`overall: ${report.ok ? 'ok' : 'ISSUES'}`);
  return out.join('\n');
}
