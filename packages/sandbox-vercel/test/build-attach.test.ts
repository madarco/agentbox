import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sbx CLI probe + credential resolution so the argv is deterministic
// and offline. renderInnerCommand is mocked to a sentinel — its real output is
// the shared cloud tmux snippet, covered by the cloud package's own tests.
const detectSbx = vi.fn();
vi.mock('../src/sbx-cli.js', () => ({ detectSbx: (...a: unknown[]) => detectSbx(...a) }));
vi.mock('../src/sdk.js', () => ({
  ensureFreshCredentials: () => Promise.resolve(),
  resolveCredentials: () => ({ token: 'vca_tok', teamId: 'team_1', projectId: 'prj_1' }),
}));
vi.mock('@agentbox/sandbox-cloud', () => ({
  renderInnerCommand: (kind: string) => `INNER(${kind})`,
}));

const { buildVercelAttach } = await import('../src/build-attach.js');
import type { BoxRecord } from '@agentbox/core';

function boxWith(sandboxId: string | undefined): BoxRecord {
  return {
    id: 'id-1',
    name: 'vbox',
    provider: 'vercel',
    container: `cloud:${sandboxId ?? ''}`,
    image: 'snap',
    workspacePath: '/workspace',
    createdAt: '2026-05-28T00:00:00Z',
    cloud: sandboxId ? { backend: 'vercel', sandboxId } : undefined,
  } as BoxRecord;
}

beforeEach(() => {
  detectSbx.mockReset();
  detectSbx.mockResolvedValue({ installed: true, bin: 'sbx' });
});

describe('buildVercelAttach', () => {
  it('rejects a record with no sandboxId', async () => {
    await expect(buildVercelAttach(boxWith(undefined), 'shell')).rejects.toThrow(/no sandboxId/);
  });

  it('throws an actionable error when the sbx CLI is not installed', async () => {
    detectSbx.mockResolvedValue({ installed: false });
    await expect(buildVercelAttach(boxWith('box-1'), 'shell')).rejects.toThrow(
      /sandbox.*CLI|npm install -g sandbox|agentbox vercel login/i,
    );
  });

  it('builds an interactive sbx exec argv for agent/shell (with -i) + token in env', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', { command: 'exec claude' });
    expect(spec.argv).toEqual([
      'sbx',
      'exec',
      '--sudo',
      '-i',
      '--project',
      'prj_1',
      '--scope',
      'team_1',
      'box-1',
      '--',
      'sudo',
      '-u',
      'vscode',
      '-H',
      'bash',
      '-lc',
      'INNER(agent)',
    ]);
    expect(spec.env).toEqual({ VERCEL_AUTH_TOKEN: 'vca_tok' });
  });

  it('omits -i for the detached pre-start path', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', { command: 'x', detached: true });
    expect(spec.argv).not.toContain('-i');
    expect(spec.argv).toContain('--sudo');
    expect(spec.argv[spec.argv.length - 1]).toBe('INNER(agent)');
  });

  it('omits -i for logs (non-interactive stream)', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'logs', { service: 'web' });
    expect(spec.argv).not.toContain('-i');
    expect(spec.argv[spec.argv.length - 1]).toBe('INNER(logs)');
  });
});
