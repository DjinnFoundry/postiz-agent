import type { Platform } from '../types.js';

/**
 * postiz-agent daemon — a long-running heartbeat loop for one tenant.
 *
 * Every `intervalMs` it asks the executor "is there anything to publish for
 * tenant T on platforms P?". The executor is the same logic the `dispatch`
 * subcommand runs, but injectable for tests. On error the loop logs the
 * problem and keeps going (transient failures should not kill the daemon;
 * cron-ish reliability beats first-fail).
 *
 * Termination paths:
 *   - maxIterations reached (tests / one-shots)
 *   - shouldStop() returns true (SIGINT/SIGTERM hook installed by the CLI)
 *   - intervalMs <= 0 (single-shot mode)
 */

export interface DispatchOutcome {
  dispatched: boolean;
  slug?: string;
  reason?: string;
  /** ISO timestamp captured by the executor. Forwarded to writer for log lines. */
  ts: string;
}

export interface DaemonOptions {
  tenant: string;
  platforms: Platform[];
  intervalMs: number;
  /** Cap iterations (mostly for tests). Infinity by default. */
  maxIterations?: number;
  /** Inject sleep (tests pass a no-op). Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject the dispatch logic (tests pass a fake). Default: invokes the real dispatch helper. */
  executor?: (tenant: string, platforms: Platform[]) => Promise<DispatchOutcome>;
  /** Polled before every sleep; when true the loop exits gracefully. */
  shouldStop?: () => boolean;
  /** Interrupt the heartbeat wait immediately on SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Sink for status / heartbeat / error lines. Default console.log. */
  writer?: (line: string) => void;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, opts.signal));
  const stopping = () => opts.signal?.aborted || opts.shouldStop?.();
  const writer = opts.writer ?? ((line: string) => console.log(line));
  const max = opts.maxIterations ?? Number.POSITIVE_INFINITY;
  const executor = opts.executor ?? defaultExecutor;

  writer(`daemon start: tenant=${opts.tenant} platforms=${opts.platforms.join(',')} intervalMs=${opts.intervalMs}`);
  let iter = 0;
  while (iter < max) {
    if (stopping()) {
      writer('daemon stop: shouldStop signaled');
      break;
    }
    iter += 1;
    writer(`heartbeat iter=${iter} tenant=${opts.tenant} ts=${new Date().toISOString()}`);
    try {
      const outcome = await executor(opts.tenant, opts.platforms);
      if (outcome.dispatched) {
        writer(`  dispatched ${outcome.slug ?? '(unknown)'} at ${outcome.ts}`);
      } else {
        writer(`  no-op (${outcome.reason ?? 'nothing pending'}) at ${outcome.ts}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer(`  iteration error (continuing): ${msg}`);
    }
    if (opts.intervalMs <= 0 || stopping()) break;
    if (iter < max) await sleep(opts.intervalMs);
  }
  writer(`daemon exit: ran ${iter} iteration(s)`);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Default executor: invokes the real dispatch+publish flow. Imported lazily
 * so tests that supply their own executor don't transitively load the entire
 * orchestrator graph.
 */
async function defaultExecutor(tenant: string, platforms: Platform[]): Promise<DispatchOutcome> {
  const { buildTenantBundle } = await import('./tenant-context.js');
  const { selectNextStory, selectPendingPlatforms } = await import('../dispatch.js');
  const { Orchestrator } = await import('../orchestrator.js');
  const { brandFromTenant } = await import('../copy/brand.js');
  const { DEFAULT_ADAPTER } = await import('../adapters/registry.js');

  const ctx = buildTenantBundle(tenant);
  const log = ctx.decisions.list({ includeArchives: true });
  const adapter = ctx.adapters.get(DEFAULT_ADAPTER);
  const candidates = adapter.listCandidates().map(c => ({ slug: c.id, generatedAtMs: c.generatedAtMs }));
  const slug = selectNextStory(candidates, log, platforms);
  if (!slug) {
    return { dispatched: false, reason: 'nothing pending', ts: new Date().toISOString() };
  }
  const orch = new Orchestrator(ctx.orchestratorDeps);
  const report = await orch.publish({
    id: slug,
    adapter: DEFAULT_ADAPTER,
    platforms: selectPendingPlatforms(log, slug, platforms),
    reason: 'daemon heartbeat dispatch',
    brand: brandFromTenant(ctx.tenant),
  });
  if (report.fatalCaptionFailure || report.results.some(result => !result.success)) {
    const failed = report.results.filter(result => !result.success).map(result => `${result.platform}: ${result.error ?? 'publish failed'}`);
    throw new Error(`Dispatch ${slug} failed: ${failed.join('; ') || 'caption failure'}`);
  }
  return { dispatched: true, slug, ts: new Date().toISOString() };
}
