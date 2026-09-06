import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { register } from '../../src/cli/commands/copy.js';
import { printJsonPretty } from '../../src/cli/io.js';

const mocks = vi.hoisted(() => ({ loadBundle: vi.fn() }));
vi.mock('../../src/cli/tenant-context.js', () => ({ buildTenantBundle: () => ({ tenant: { brand: { name: 'Tenant Brand' } }, adapters: { get: () => ({ loadBundle: mocks.loadBundle }) } }) }));
vi.mock('../../src/cli/io.js', () => ({ printJsonPretty: vi.fn() }));
beforeEach(() => { mocks.loadBundle.mockReturnValue({ id: 'tenant-story', kind: 'text', locale: 'es', text: { title: 'Tenant story', body: 'Unique tenant content.' } }); });
afterEach(() => vi.clearAllMocks());
function command() { const program = new Command().exitOverride(); register(program); return program; }

describe('copy preview tenant routing', () => {
  it('loads the requested tenant adapter before producing a caption', async () => {
    await command().parseAsync(['copy', 'preview', '--tenant', 'test-brand', '--id', 'tenant-story', '--platform', 'x', '--json'], { from: 'user' });
    expect(mocks.loadBundle).toHaveBeenCalledWith('tenant-story');
    expect(printJsonPretty).toHaveBeenCalledWith({ x: expect.objectContaining({ caption: expect.stringContaining('Unique tenant content') }) });
  });
  it('rejects an unknown platform rather than silently producing mismatched copy', async () => {
    await expect(command().parseAsync(['copy', 'preview', '--tenant', 'test-brand', '--id', 'tenant-story', '--platform', 'invalid'], { from: 'user' })).rejects.toThrow(/invalid|platform/i);
    expect(mocks.loadBundle).not.toHaveBeenCalled();
  });
  it('rejects mutually exclusive content sources', async () => {
    await expect(command().parseAsync(['copy', 'preview', '--id', 'tenant-story', '--bundle-file', 'other.json'], { from: 'user' })).rejects.toThrow(/not both|either/);
    expect(mocks.loadBundle).not.toHaveBeenCalled();
  });
});
