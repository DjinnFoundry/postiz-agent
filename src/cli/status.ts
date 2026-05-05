import { existsSync, accessSync, constants } from 'node:fs';
import { DecisionLog } from '../decisions/log.js';
import { findStuckSlugs } from '../dispatch.js';
import { PostizClient, probePostizIntegrations, type PostizIntegration } from '../platforms/postiz.js';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import { createDefaultRegistry } from '../tools/index.js';
import { loadCatalog, ThemeDecisionStore } from '../theme/catalog.js';
import { UploadCache } from '../lib/upload-cache.js';
import { filterPublishes, filterWindow } from './decisions-window.js';
import type { DecisionLogEntry, Platform } from '../types.js';

export interface StatusCheck {
  label: string;
  ok: boolean;
  detail?: string;
  required: boolean;
  warning?: boolean;
}

export interface StatusSuccessRate7d {
  success: number;
  failed: number;
  rate: number;
}

export interface StatusUploads {
  count: number;
  oldestUploadedAt: string | null;
}

export interface StatusSystem {
  tools: number;
  treatments: number;
  decisions: number;
  themeDecisions: number;
  uploads: StatusUploads;
  stuckSlugs: number;
  successRate7d: StatusSuccessRate7d;
}

export interface StatusReport {
  generatedAt: string;
  deps: StatusCheck[];
  system: StatusSystem;
}

export interface StatusInput {
  now?: Date;
  decisions?: DecisionLogEntry[];
  audiokidsDir?: string;
  postizApiKey?: string;
  listIntegrations?: () => Promise<PostizIntegration[]>;
  uploadCache?: { count: number; oldestUploadedAt: string | null; exists: boolean };
  themeDecisions?: { count: number; exists: boolean };
  toolNames?: string[];
  treatmentIds?: string[];
  binChecks?: () => Promise<StatusCheck[]>;
}

const ALL_PLATFORMS: Platform[] = ['x', 'tiktok', 'instagram', 'youtube', 'spotify'];

export async function runStatus(input: StatusInput = {}): Promise<StatusReport> {
  const now = input.now ?? new Date();
  const decisions = input.decisions ?? new DecisionLog().list();
  const audiokidsDir = input.audiokidsDir ?? config.audiokids.outputDir;
  const postizApiKey = input.postizApiKey ?? config.postiz.apiKey;
  const listIntegrations = input.listIntegrations ?? (() => new PostizClient().listIntegrations());
  const uploadCache = input.uploadCache ?? new UploadCache().summarize();
  const themeDecisions = input.themeDecisions ?? new ThemeDecisionStore().summarize();
  const toolNames = input.toolNames ?? createDefaultRegistry().names();
  const treatmentIds = input.treatmentIds ?? loadCatalog().treatments.map(t => t.id);
  const binChecks = input.binChecks ?? defaultBinChecks;

  const deps: StatusCheck[] = [];
  deps.push(...await binChecks());
  deps.push(...buildAudiokidsDepChecks(audiokidsDir));
  deps.push(...await buildPostizDepChecks(postizApiKey, listIntegrations));
  deps.push({
    label: 'YouTubeCLI project path',
    ok: existsSync(config.youtubecli.path),
    detail: config.youtubecli.path,
    required: false,
  });

  const stuck = findStuckSlugs(decisions, ALL_PLATFORMS, now);

  const windowed = filterWindow(decisions, { now, days: 7 });
  const publishes7d = filterPublishes(windowed);
  let success = 0;
  let failed = 0;
  for (const e of publishes7d) {
    const r = e.result;
    if (!r || r.skipped) continue;
    if (r.success) success += 1;
    else failed += 1;
  }
  const denom = success + failed;
  const rate = denom === 0 ? 0 : success / denom;

  const system: StatusSystem = {
    tools: toolNames.length,
    treatments: treatmentIds.length,
    decisions: decisions.length,
    themeDecisions: themeDecisions.count,
    uploads: { count: uploadCache.count, oldestUploadedAt: uploadCache.oldestUploadedAt },
    stuckSlugs: stuck.length,
    successRate7d: { success, failed, rate },
  };

  return {
    generatedAt: now.toISOString(),
    deps,
    system,
  };
}

async function defaultBinChecks(): Promise<StatusCheck[]> {
  const out: StatusCheck[] = [];
  out.push(await binCheck('ffmpeg', '-version', true));
  out.push(await binCheck('ffprobe', '-version', true));
  out.push(await binCheck('whisper', '--help', false));
  out.push(await binCheck('npx', '--version', true));
  return out;
}

async function binCheck(cmd: string, testArg: string, required: boolean): Promise<StatusCheck> {
  try {
    await run(cmd, [testArg]);
    return { label: `${cmd} installed`, ok: true, required };
  } catch (err) {
    return {
      label: `${cmd} installed`,
      ok: false,
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
      required,
    };
  }
}

function buildAudiokidsDepChecks(akDir: string): StatusCheck[] {
  const out: StatusCheck[] = [];
  out.push({
    label: 'AudioKids output dir',
    ok: existsSync(akDir),
    detail: akDir,
    required: true,
  });
  try {
    accessSync(akDir, constants.R_OK);
    out.push({ label: 'AudioKids output dir readable', ok: true, required: true });
  } catch (err) {
    out.push({
      label: 'AudioKids output dir readable',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      required: true,
    });
  }
  return out;
}

async function buildPostizDepChecks(
  apiKey: string,
  listIntegrations: () => Promise<PostizIntegration[]>,
): Promise<StatusCheck[]> {
  const out: StatusCheck[] = [];
  try {
    const res = await fetch(`${config.postiz.apiUrl.replace(/\/public\/v1$/, '')}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    out.push({
      label: 'Postiz API reachable',
      ok: true,
      detail: `${config.postiz.apiUrl} (HTTP ${res.status})`,
      required: false,
    });
  } catch (err) {
    out.push({
      label: 'Postiz API reachable',
      ok: false,
      detail: `${config.postiz.apiUrl} · ${err instanceof Error ? err.message : err}`,
      required: false,
    });
  }

  out.push({
    label: 'POSTIZ_API_KEY set',
    ok: Boolean(apiKey),
    detail: apiKey ? 'present' : 'missing in .env',
    required: false,
  });

  if (apiKey) {
    const probe = await probePostizIntegrations(apiKey, listIntegrations);
    if (probe.kind === 'unreachable') {
      out.push({ label: 'Postiz integrations', ok: false, detail: `could not query: ${probe.message}`, required: false, warning: true });
    } else if (probe.kind === 'ok') {
      const wanted: Array<'x' | 'tiktok' | 'instagram' | 'youtube'> = ['x', 'tiktok', 'instagram', 'youtube'];
      for (const p of wanted) {
        const status = probe.perPlatform[p];
        if (!status || status.state === 'missing') {
          out.push({ label: `${p} integration`, ok: false, detail: `not connected; connect at ${probe.reconnectUrl}`, required: false, warning: true });
        } else if (status.state === 'disabled') {
          out.push({ label: `${p} integration`, ok: false, detail: `${status.name} disabled; reconnect at ${probe.reconnectUrl}`, required: false, warning: true });
        } else {
          out.push({ label: `${p} integration`, ok: true, detail: status.name, required: false });
        }
      }
    }
  }

  return out;
}

export function formatStatusReport(report: StatusReport, mode: 'human' | 'json'): string {
  if (mode === 'json') return JSON.stringify(report, null, 2);

  const out: string[] = [];
  out.push('── deps ──');
  for (const c of report.deps) {
    const mark = c.ok ? '✓' : c.warning ? '⚠' : '✗';
    const hint = c.detail ? `  ${c.detail}` : '';
    out.push(`  ${mark} ${c.label}${hint}`);
  }
  out.push('');
  out.push('── system ──');
  const s = report.system;
  out.push(`  tools:           ${s.tools}`);
  out.push(`  treatments:      ${s.treatments}`);
  out.push(`  decisions:       ${s.decisions}`);
  out.push(`  theme decisions: ${s.themeDecisions}`);
  out.push(`  uploads:         ${s.uploads.count}${s.uploads.oldestUploadedAt ? ` (oldest ${s.uploads.oldestUploadedAt})` : ''}`);
  out.push(`  stuck slugs:     ${s.stuckSlugs}`);
  const ratePct = (s.successRate7d.rate * 100).toFixed(1);
  out.push(`  7d success rate: ${s.successRate7d.success}/${s.successRate7d.success + s.successRate7d.failed} (${ratePct}%)`);
  return out.join('\n');
}
