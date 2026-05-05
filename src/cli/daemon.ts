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
  /** Sink for status / heartbeat / error lines. Default console.log. */
  writer?: (line: string) => void;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const writer = opts.writer ?? ((line: string) => console.log(line));
  const max = opts.maxIterations ?? Number.POSITIVE_INFINITY;
  const executor = opts.executor ?? defaultExecutor;

  writer(`daemon start: tenant=${opts.tenant} platforms=${opts.platforms.join(',')} intervalMs=${opts.intervalMs}`);
  let iter = 0;
  while (iter < max) {
    if (opts.shouldStop?.()) {
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
    if (iter < max) await sleep(opts.intervalMs);
  }
  writer(`daemon exit: ran ${iter} iteration(s)`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default executor: invokes the real dispatch+publish flow. Imported lazily
 * so tests that supply their own executor don't transitively load the entire
 * orchestrator graph.
 */
async function defaultExecutor(tenant: string, platforms: Platform[]): Promise<DispatchOutcome> {
  const { buildTenantBundle } = await import('./tenant-context.js');
  const { selectNextStory } = await import('../dispatch.js');
  const { Orchestrator } = await import('../orchestrator.js');
  const { brandFromTenant } = await import('../copy/brand.js');
  const { DEFAULT_ADAPTER } = await import('../adapters/registry.js');

  const ctx = buildTenantBundle(tenant);
  const log = ctx.decisions.list();
  const adapter = ctx.adapters.get(DEFAULT_ADAPTER);
  const candidates = adapter.listCandidates().map(c => ({ slug: c.id, generatedAtMs: c.generatedAtMs }));
  const slug = selectNextStory(candidates, log, platforms);
  if (!slug) {
    return { dispatched: false, reason: 'nothing pending', ts: new Date().toISOString() };
  }
  const orch = new Orchestrator({ adapters: ctx.adapters, decisions: ctx.decisions });
  await orch.publish({
    id: slug,
    adapter: DEFAULT_ADAPTER,
    platforms,
    reason: 'daemon heartbeat dispatch',
    brand: brandFromTenant(ctx.tenant),
  });
  return { dispatched: true, slug, ts: new Date().toISOString() };
}
