import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedCarryEntry } from '@agentbox/core';

// execa is mocked so the tests never touch a real docker daemon.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

// The tar streaming lives in box-cp.js; stub it so no bytes actually move.
const { streamTarPipeMock } = vi.hoisted(() => ({ streamTarPipeMock: vi.fn() }));
vi.mock('../src/box-cp.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamTarPipe: streamTarPipeMock,
}));

const { copyCarryPathsToBox } = await import('../src/sync/host-export.js');

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agentbox-carry-chown-'));
  execaMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  streamTarPipeMock.mockReset();
  streamTarPipeMock.mockResolvedValue([
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
  ]);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function entry(over: Partial<ResolvedCarryEntry>): ResolvedCarryEntry {
  return {
    rawSrc: 'x',
    rawDest: '~/x',
    absSrc: join(workspace, 'x'),
    absDest: '~/x',
    kind: 'file',
    bytes: 1,
    optional: false,
    ...over,
  } as ResolvedCarryEntry;
}

/** All `docker exec` argvs the run issued, as arrays. */
function execArgvs(): string[][] {
  return execaMock.mock.calls.filter((c) => c[0] === 'docker').map((c) => c[1] as string[]);
}

/**
 * `copyOneEntry` builds its chown as an execa **argv**, not a shell string, so
 * these assert the tokens land unquoted and in the right slots. The site is
 * otherwise untested (it needs a container), and it is where the uid-1000
 * hardcode lived.
 */
describe('docker carry chown', () => {
  it('chowns to the box user by reference, with no numeric uid', async () => {
    await writeFile(join(workspace, 'x'), 'hi');

    const res = await copyCarryPathsToBox({
      container: 'agentbox-test',
      entries: [entry({ absDest: '~/marker.txt' })],
    });
    expect(res.errors).toEqual([]);
    expect(res.copied).toBe(1);

    const chown = execArgvs().find((a) => a.includes('chown'));
    expect(chown).toEqual([
      'exec',
      '--user',
      '0:0',
      'agentbox-test',
      'chown',
      '-R',
      '--reference=/home/vscode',
      '/home/vscode/marker.txt',
    ]);
    // 1000 is `vscode` on docker but NOT on vercel/e2b; the plan is shared, so
    // no numeric owner may survive here either.
    expect(chown!.join(' ')).not.toContain('1000:1000');
  });

  it('uses the same owner token for the leaf and the parent chain', async () => {
    await writeFile(join(workspace, 'x'), 'hi');

    await copyCarryPathsToBox({
      container: 'agentbox-test',
      entries: [entry({ absDest: '~/.ssh/id_ed25519', mode: 0o600 })],
    });

    const argvs = execArgvs();
    const chown = argvs.find((a) => a.includes('chown'))!;
    expect(chown).toContain('--reference=/home/vscode');

    const script = argvs.find((a) => a.includes('bash'))?.at(-1) ?? '';
    expect(script).toContain('while [ "$parent" != "/home/vscode" ]');
    expect(script).toContain('chown --reference=/home/vscode "$parent"');
  });

  it('keeps an explicit user: numeric (user: 0 means literal root:root)', async () => {
    await writeFile(join(workspace, 'x'), 'hi');

    await copyCarryPathsToBox({
      container: 'agentbox-test',
      entries: [entry({ absDest: '/etc/agentbox/x', user: 0 })],
    });

    const chown = execArgvs().find((a) => a.includes('chown'))!;
    expect(chown).toContain('0:0');
    expect(chown).not.toContain('--reference=/home/vscode');
  });
});
