import { DecisionLog } from '../decisions/log.js';
import { UploadCache } from '../lib/upload-cache.js';
import { PostizClient } from '../platforms/postiz.js';
import { AdapterRegistry, createDefaultRegistry } from '../adapters/registry.js';
import { ThemeDecisionStore } from '../theme/catalog.js';
import { loadTenant, type TenantContext } from '../core/tenant.js';

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
}

export function buildTenantBundle(slug: string = 'default'): TenantBundle {
  const tenant = loadTenant(slug);
  const decisions = new DecisionLog(tenant.paths.decisionsLog);
  const uploadCache = new UploadCache(tenant.paths.uploadCache);
  const themeDecisions = new ThemeDecisionStore(tenant.paths.themeDecisions);
  const adapters = createDefaultRegistry({ audiokidsDir: tenant.audiokids.outputDir });

  let cachedClient: PostizClient | null = null;
  const postiz = (): PostizClient => {
    if (cachedClient) return cachedClient;
    cachedClient = new PostizClient(tenant.postiz.apiUrl, tenant.postiz.apiKey, uploadCache);
    return cachedClient;
  };

  return { tenant, decisions, uploadCache, themeDecisions, postiz, adapters };
}
