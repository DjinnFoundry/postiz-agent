import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDaemon } from '../../src/cli/daemon.js';

const mocks = vi.hoisted(() => ({ publish: vi.fn(), list: vi.fn(() => []) }));
vi.mock('../../src/cli/tenant-context.js', () => ({
  buildTenantBundle: () => ({
    tenant: { brand: {} },
    decisions: { list: mocks.list },
    adapters: { get: () => ({ listCandidates: () => [{ id: 'pending', generatedAtMs: 0 }] }) },
    orchestratorDeps: {},
  }),
}));
vi.mock('../../src/orchestrator.js', () => ({ Orchestrator: class { publish = mocks.publish; } }));
beforeEach(() => vi.clearAllMocks());

describe('daemon publication result', () => {
  it('logs a failure rather than a successful dispatch when the report fails', async () => {
    mocks.publish.mockResolvedValue({ results: [{ platform: 'x', success: false, error: 'reconnect account' }] });
    const lines: string[] = [];
    await runDaemon({ tenant: 'default', platforms: ['x'], intervalMs: 1, maxIterations: 1, writer: line => lines.push(line) });
    expect(lines.some(line => line.includes('iteration error') && line.includes('reconnect account'))).toBe(true);
    expect(lines.some(line => line.includes('  dispatched '))).toBe(false);
    expect(mocks.list).toHaveBeenCalledWith({ includeArchives: true });
  });
  it('does not report a fatal caption failure as successful', async () => {
    mocks.publish.mockResolvedValue({ results: [], fatalCaptionFailure: true });
    const lines: string[] = [];
    await runDaemon({ tenant: 'default', platforms: ['x'], intervalMs: 1, maxIterations: 1, writer: line => lines.push(line) });
    expect(lines.some(line => line.includes('caption failure'))).toBe(true);
    expect(lines.some(line => line.includes('  dispatched '))).toBe(false);
  });
});
