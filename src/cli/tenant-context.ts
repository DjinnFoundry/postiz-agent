import { join } from 'node:path';
import type { OrchestratorDeps } from '../orchestrator.js';
import { YoutubeAdapter } from '../platforms/youtube.js';
import { getPublisher } from '../platforms/registry.js';
import { SlideVideoBuilder } from '../media/slide-video.js';
import { DecisionLog } from '../decisions/log.js';
import { UploadCache } from '../lib/upload-cache.js';
import { PostizClient } from '../platforms/postiz.js';
import { AdapterRegistry, createDefaultRegistry } from '../adapters/registry.js';
import { ThemeDecisionStore } from '../theme/catalog.js';
import { loadTenant, type TenantContext, type LoadTenantOptions } from '../core/tenant.js';

/**
 * Resolved tenant + every store / client an action needs, all wired to
 * tenant-specific paths. CLI subcommands call this once and pass the parts
 * down to whatever helper they invoke (Orchestrator, runDoctor, runStats, ...).
 */
export interface TenantBundle {
  tenant: TenantContext;
  decisions: DecisionLog;
  uploadCache: UploadCache;
  themeDecisions: ThemeDecisionStore;
  /** Pre-built Postiz client wired to the tenant's apiUrl + apiKey + cache. Lazy: only build on demand. */
  postiz: () => PostizClient;
  /** Adapter registry whose audiokids adapter reads the tenant's outputDir. */
  adapters: AdapterRegistry;
  getPublisher: NonNullable<OrchestratorDeps['getPublisher']>;
  /** All publication dependencies scoped to this tenant, for CLI and daemon. */
  orchestratorDeps: OrchestratorDeps;
  /** Lightweight digests of the tenant's caches; consumed by doctor / status. */
  summaries: () => TenantSummaries;
}

export interface TenantSummaries {
  uploadCache: { count: number; oldestUploadedAt: string | null; exists: boolean };
  themeDecisions: { count: number; exists: boolean };
}

export function buildTenantBundle(slug: string = 'default', opts: LoadTenantOptions = {}): TenantBundle {
  const tenant = loadTenant(slug, opts);
  const decisions = new DecisionLog(tenant.paths.decisionsLog);
  const uploadCache = new UploadCache(tenant.paths.uploadCache);
  const themeDecisions = new ThemeDecisionStore(tenant.paths.themeDecisions);
  const adapters = createDefaultRegistry({ audiokidsDir: tenant.audiokids.outputDir });

  let cachedClient: PostizClient | null = null;
  const postiz = (): PostizClient => {
    if (cachedClient) return cachedClient;
    cachedClient = new PostizClient(tenant.postiz.apiUrl, tenant.postiz.apiKey, uploadCache, {
      integrationIds: tenant.postiz.integrationIds,
      platformSettings: tenant.postiz.platformSettings,
    });
    return cachedClient;
  };

  const slides = new SlideVideoBuilder({
    workRoot: join(tenant.paths.tmpDir, 'hyperframes'),
    renderLogsDir: tenant.paths.renderLogsDir,
    themeDecisions,
  });
  const youtube = new YoutubeAdapter(tenant.youtubecli.path, tenant.youtubecli.channelId);
  const publisher: TenantBundle['getPublisher'] = platform => getPublisher(platform, { postiz, youtube, slides });
  const orchestratorDeps: OrchestratorDeps = {
    adapters,
    decisions,
    getPublisher: publisher,
    workDir: tenant.paths.tmpDir,
    alertWebhookUrl: tenant.alerts.webhookUrl,
  };

  const summaries = (): TenantSummaries => ({
    uploadCache: uploadCache.summarize(),
    themeDecisions: themeDecisions.summarize(),
  });

  return { tenant, decisions, uploadCache, themeDecisions, postiz, adapters, getPublisher: publisher, orchestratorDeps, summaries };
}
