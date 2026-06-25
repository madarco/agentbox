import { describe, expect, it, vi } from 'vitest';

// Mock the SDK loader so we don't have to set E2B_API_KEY for these unit
// tests. renderInnerCommand is mocked to a sentinel — its real output is the
// shared cloud tmux snippet, covered by the cloud package's own tests.
// existsSync is mocked so the test doesn't depend on whether the helper has
// been built (`pnpm build` in this package writes dist/attach-helper.cjs, but
// the test must work even before that).
vi.mock('../src/sdk.js', () => ({
  resolveApiKey: () => 'e2b_test_key',
}));
vi.mock('@agentbox/sandbox-cloud', () => ({
  renderInnerCommand: (kind: string) => `INNER(${kind})`,
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: () => true,
  };
});

const { buildE2bAttach, resolveAttachHelperPath } = await import('../src/build-attach.js');
import type { BoxRecord } from '@agentbox/core';

function boxWith(sandboxId: string | undefined): BoxRecord {
  return {
    id: 'id-1',
    name: 'ebox',
    provider: 'e2b',
    container: `cloud:${sandboxId ?? ''}`,
    image: 'tmpl_x:latest',
    workspacePath: '/workspace',
    createdAt: '2026-06-03T00:00:00Z',
    cloud: sandboxId ? { backend: 'e2b', sandboxId } : undefined,
  } as BoxRecord;
}

describe('buildE2bAttach', () => {
  it('rejects a record with no sandboxId', async () => {
    await expect(buildE2bAttach(boxWith(undefined), 'shell')).rejects.toThrow(/no sandboxId/);
  });

  it('returns node + helper-path argv with inner cmd + api key in env', async () => {
    const spec = await buildE2bAttach(boxWith('sbx_1'), 'agent', { command: 'exec claude' });
    // argv[0] is node (process.execPath); we don't pin its absolute path —
    // just verify it points at a node executable + the helper.
    expect(spec.argv[0]).toMatch(/node$/);
    expect(spec.argv).toEqual([
      spec.argv[0],
      resolveAttachHelperPath(),
      '--sandbox-id',
      'sbx_1',
      '--user',
      'vscode',
    ]);
    expect(spec.env).toEqual({
      E2B_API_KEY: 'e2b_test_key',
      AGENTBOX_E2B_INNER_CMD: 'INNER(agent)',
      AGENTBOX_HOST_TERM: process.env['TERM'] ?? 'xterm-256color',
    });
  });

  it('omits --detached for a normal (interactive) attach', async () => {
    const spec = await buildE2bAttach(boxWith('sbx_1'), 'agent', { command: 'exec claude' });
    expect(spec.argv).not.toContain('--detached');
  });

  it('appends --detached for a detached pre-start so the helper runs once and exits', async () => {
    const spec = await buildE2bAttach(boxWith('sbx_1'), 'agent', {
      command: 'exec claude',
      detached: true,
    });
    expect(spec.argv).toContain('--detached');
  });

  it('passes the kind through to renderInnerCommand', async () => {
    const spec = await buildE2bAttach(boxWith('sbx_1'), 'logs', { service: 'web' });
    expect(spec.env?.AGENTBOX_E2B_INNER_CMD).toBe('INNER(logs)');
  });

  it('also resolves shell kind', async () => {
    const spec = await buildE2bAttach(boxWith('sbx_1'), 'shell');
    expect(spec.env?.AGENTBOX_E2B_INNER_CMD).toBe('INNER(shell)');
  });
});
