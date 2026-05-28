import { describe, expect, it, vi } from 'vitest';

// Pretend the compiled attach-helper.js exists so resolveAttachHelperPath()
// doesn't depend on a prior build when running the unit test.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

import { buildVercelAttach } from '../src/build-attach.js';
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

function decodeSpec(argv: string[]): Record<string, unknown> {
  const b64 = argv[argv.length - 1]!;
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('buildVercelAttach', () => {
  it('rejects a record with no sandboxId', async () => {
    await expect(buildVercelAttach(boxWith(undefined), 'shell')).rejects.toThrow(/no sandboxId/);
  });

  it('encodes the agent session spec into the helper argv', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', { command: 'bash -lc exec\\ claude' });
    // argv = [node, helperPath, sandboxId, base64(spec)]
    expect(spec.argv).toHaveLength(4);
    expect(spec.argv[2]).toBe('box-1');
    const decoded = decodeSpec(spec.argv);
    expect(decoded).toMatchObject({
      sessionName: 'agent',
      command: 'bash -lc exec\\ claude',
      kind: 'agent',
    });
  });

  it('defaults the session name to the kind and shell command to a login shell', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'shell');
    const decoded = decodeSpec(spec.argv);
    expect(decoded).toMatchObject({ sessionName: 'shell', command: 'bash -l', kind: 'shell' });
  });

  it('carries the detached flag for the pre-start path', async () => {
    const spec = await buildVercelAttach(boxWith('box-1'), 'agent', { command: 'x', detached: true });
    expect(decodeSpec(spec.argv).detached).toBe(true);
  });
});
