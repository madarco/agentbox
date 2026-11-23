import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sbx CLI probe + credential resolution so the argv is deterministic
// and offline. renderInnerCommand is mocked to a sentinel — its real output is
// the shared cloud tmux snippet, covered by the cloud package's own tests.
const detectSbx = vi.fn();
vi.mock('../src/sbx-cli.js', () => ({
  detectSbx: (...a: unknown[]) => detectSbx(...a),
  installSbxHint: () => 'npm install -g sandbox@latest',
  updateSbxHint: (d: { path?: string }) =>
    `\`pnpm add -g sandbox@latest\` (the CLI on PATH is ${d.path})`,
  MIN_SBX_MAJOR: 4,
  BROKEN_NODE_MAJOR: 26,
}));
// The SDK exec helper is a build output; pretend it exists so the argv is built.
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  existsSync: () => true,
}));
vi.mock('../src/sdk.js', () => ({
  ensureFreshCredentials: () => Promise.resolve(),
  resolveCredentials: () => ({ token: 'vca_tok', teamId: 'team_1', projectId: 'prj_1' }),
}));
vi.mock('@agentbox/sandbox-cloud', () => ({
  renderInnerCommand: (kind: string) => `INNER(${kind})`,
  hostTermForCloud: () => 'xterm-256color',
}));

const { buildVercelAttach } = await import('../src/build-attach.js');
import type { BoxRecord } from '@agentbox/core';

// The attach inner is prefixed with a UTF-8/TERM prelude (sbx forwards neither).
// TERM comes from hostTermForCloud (mocked to xterm-256color here); the
// renderInnerCommand guard handles the box-side fallback.
const PRELUDE = 'export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color; ';

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
      `${PRELUDE}INNER(agent)`,
    ]);
    expect(spec.env).toEqual({ VERCEL_AUTH_TOKEN: 'vca_tok' });
  });

  it('refuses an outdated sbx on Node 26+ and names the resolved binary', async () => {
    detectSbx.mockResolvedValue({
      installed: true,
      bin: 'sbx',
      path: '/Users/me/Library/pnpm/sbx',
      version: '3.0.1',
      nodeMajor: 26,
      outdated: true,
      broken: true,
    });
    await expect(buildVercelAttach(boxWith('box-1'), 'agent', { command: 'x' })).rejects.toThrow(
      /3\.0\.1.*Node 26.*4\.x.*pnpm add -g sandbox@latest.*\/Users\/me\/Library\/pnpm\/sbx/s,
    );
  });

  it('warns but still attaches with an outdated sbx on Node < 26', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    detectSbx.mockResolvedValue({
      installed: true,
      bin: 'sbx',
      path: '/usr/local/bin/sbx',
      version: '3.0.1',
      nodeMajor: 24,
      outdated: true,
      broken: false,
    });
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', { command: 'x' });
    expect(spec.argv.slice(0, 4)).toEqual(['sbx', 'exec', '--sudo', '-i']);
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/warning: .*3\.0\.1.*older than 4\.x/),
    );
    write.mockRestore();
  });

  it('runs the detached pre-start on the SDK helper, not sbx, even with an outdated sbx', async () => {
    detectSbx.mockResolvedValue({ installed: true, bin: 'sbx', version: '3.0.1', outdated: true });
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', {
      command: 'x',
      detached: true,
    });
    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/exec-helper\.cjs$/);
    expect(spec.argv.slice(2)).toEqual(['--sandbox-id', 'box-1', '--user', 'vscode']);
    expect(spec.env).toEqual({
      VERCEL_AUTH_TOKEN: 'vca_tok',
      AGENTBOX_VERCEL_TEAM_ID: 'team_1',
      AGENTBOX_VERCEL_PROJECT_ID: 'prj_1',
      AGENTBOX_VERCEL_INNER_CMD: `${PRELUDE}INNER(agent)`,
    });
    // The token never rides argv.
    expect(spec.argv.join(' ')).not.toContain('vca_tok');
    expect(detectSbx).not.toHaveBeenCalled();
  });

  it('runs logs on the SDK helper too', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'logs', { service: 'web' });
    expect(spec.argv[1]).toMatch(/exec-helper\.cjs$/);
    expect(spec.env?.AGENTBOX_VERCEL_INNER_CMD).toBe(`${PRELUDE}INNER(logs)`);
    expect(detectSbx).not.toHaveBeenCalled();
  });
});
