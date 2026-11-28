import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@agentbox/core';

// execa is mocked so the tests never touch a real docker daemon.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { makeDockerSync } = await import('../src/sync/docker-sync.js');

let home: string;
let lines: string[];

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    boxName: 'b',
    boxId: 'id',
    provider: 'docker',
    hostWorkspace: '/w',
    projectRoot: '/w',
    boxWorkspace: '/workspace',
    hostHome: home,
    onLog: (l) => lines.push(l),
    gitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com', source: 'request' },
    ...over,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentbox-docker-gitid-'));
  lines = [];
  execaMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('docker seedGitIdentity', () => {
  it('writes both halves globally when the building machine has no ~/.gitconfig', async () => {
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    // One call and no probe: an identity already in the box came from another
    // create (a checkpoint), so it must not be mistaken for this machine's.
    expect(execaMock).toHaveBeenCalledTimes(1);
    const argv = execaMock.mock.calls[0]?.[1] as string[];
    expect(argv).toContain('box1');
    expect(argv.join(' ')).toContain('git config --global user.name');
    expect(argv.slice(-2)).toEqual(['Ada Lovelace', 'ada@example.com']);
    expect(lines.join('\n')).toContain('(from the requesting machine)');
  });

  it('keeps the bind-mounted ~/.gitconfig and writes nothing when the machine has one', async () => {
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Host\n');
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    expect(execaMock).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('bind-mounted ~/.gitconfig');
  });

  it('does nothing without a resolved identity', async () => {
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    expect(execaMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
