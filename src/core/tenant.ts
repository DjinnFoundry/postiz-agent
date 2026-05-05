import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';
import { readJsonOr } from '../lib/json-file.js';

/**
 * Multi-tenant config + paths.
 *
 * postiz-agent is a toolkit each external agent uses to manage ONE product's
 * social presence (audiokids, zetaread, ...). Each product is a "tenant" with
 * isolated data (decisions log, caches, render logs) and optional config
 * overrides (its own Postiz instance, brand identity, audiokids output dir).
 *
 * Conventions:
 *  - The `default` tenant uses LEGACY paths (`data/decisions.jsonl`,
 *    `data/upload-cache.json`, ...) so existing single-tenant setups keep
 *    working without migration.
 *  - Named tenants (anything else) get their own subdirectory:
 *    `data/<slug>/decisions.jsonl`, `data/<slug>/upload-cache.json`, ...
 *  - Per-tenant overrides live at `tenants/<slug>/config.json`. Anything not
 *    overridden falls through to the .env defaults exposed via `config`.
 */

export interface TenantContext {
  slug: string;
  postiz: { apiUrl: string; apiKey: string };
  audiokids: { outputDir: string };
  youtubecli: { path: string };
  alerts: { webhookUrl: string };
  paths: {
    dataDir: string;
    decisionsLog: string;
    uploadCache: string;
    themeDecisions: string;
    renderLogsDir: string;
    coversDir: string;
    galleriesDir: string;
  };
  brand: {
    name?: string;
    defaultHashtags?: string[];
    /** Future: voice persona, default mood, CTA pool overrides, etc. */
    [k: string]: unknown;
  };
}

export interface LoadTenantOptions {
  /** Project root used as the base for `data/` and `tenants/`. Defaults to config.paths.projectRoot. */
  rootDir?: string;
}

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadTenant(slug: string = 'default', opts: LoadTenantOptions = {}): TenantContext {
  if (!VALID_SLUG.test(slug)) {
    throw new Error(`invalid tenant slug "${slug}". Expected lowercase alphanumeric with dashes, ≤64 chars.`);
  }
  const root = opts.rootDir ?? config.paths.projectRoot;
  const overrides = readTenantConfig(root, slug);

  const dataDir = slug === 'default'
    ? resolve(root, 'data')
    : resolve(root, 'data', slug);

  return {
    slug,
    postiz: {
      apiUrl: overrides?.postiz?.apiUrl ?? config.postiz.apiUrl,
      apiKey: overrides?.postiz?.apiKey ?? config.postiz.apiKey,
    },
    audiokids: {
      outputDir: overrides?.audiokids?.outputDir ?? config.audiokids.outputDir,
    },
    youtubecli: {
      path: overrides?.youtubecli?.path ?? config.youtubecli.path,
    },
    alerts: {
      webhookUrl: overrides?.alerts?.webhookUrl ?? config.alerts.webhookUrl,
    },
    paths: {
      dataDir,
      decisionsLog: join(dataDir, 'decisions.jsonl'),
      uploadCache: join(dataDir, 'upload-cache.json'),
      themeDecisions: join(dataDir, 'theme-decisions.json'),
      renderLogsDir: join(dataDir, 'render-logs'),
      coversDir: join(dataDir, 'covers'),
      galleriesDir: join(dataDir, 'galleries'),
    },
    brand: overrides?.brand ?? {},
  };
}

export function listTenants(opts: LoadTenantOptions = {}): string[] {
  const root = opts.rootDir ?? config.paths.projectRoot;
  const dir = resolve(root, 'tenants');
  if (!existsSync(dir)) return ['default'];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return ['default'];
  }
  const named = entries
    .filter(name => {
      try {
        return statSync(join(dir, name)).isDirectory() && VALID_SLUG.test(name) && name !== 'default';
      } catch {
        return false;
      }
    })
    .sort();
  return ['default', ...named];
}

interface TenantOverrides {
  postiz?: { apiUrl?: string; apiKey?: string };
  audiokids?: { outputDir?: string };
  youtubecli?: { path?: string };
  alerts?: { webhookUrl?: string };
  brand?: TenantContext['brand'];
}

function readTenantConfig(root: string, slug: string): TenantOverrides | null {
  const path = resolve(root, 'tenants', slug, 'config.json');
  return readJsonOr<TenantOverrides | null>(path, null, {
    validate: (raw) => (raw && typeof raw === 'object' ? raw as TenantOverrides : undefined),
  });
}
