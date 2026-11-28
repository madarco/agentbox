import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@agentbox/core';

// `docker` is mocked so the tests never touch a daemon; the host-side
// `git config --file ~/.gitconfig` read goes to the real git.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));
const realExeca = (await vi.importActual<typeof import('execa')>('execa')).execa;

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
  execaMock.mockImplementation((cmd: string, args: string[], opts: object) =>
    cmd === 'git'
      ? realExeca(cmd, args, opts)
      : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The `docker exec` argv lists, ignoring the host-side git reads. */
const dockerCalls = (): string[][] =>
  execaMock.mock.calls.filter((c) => c[0] === 'docker').map((c) => c[1] as string[]);

describe('docker seedGitIdentity', () => {
  it('writes both halves to the box ~/.gitconfig when the machine has none to mount', async () => {
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    // One write and no probe of the box: whatever it holds came from another
    // create (a checkpoint), so it is overwritten rather than trusted.
    expect(dockerCalls()).toHaveLength(1);
    const argv = dockerCalls()[0]!;
    expect(argv.slice(0, 4)).toEqual(['exec', '--user', 'vscode', 'box1']);
    expect(argv.join(' ')).toContain('git config --global user.name');
    expect(argv.slice(-2)).toEqual(['Ada Lovelace', 'ada@example.com']);
    expect(lines.join('\n')).toContain('(from the requesting machine)');
  });

  it('keeps a mounted ~/.gitconfig that holds a complete identity', async () => {
    await writeFile(
      join(home, '.gitconfig'),
      '[user]\n\tname = Host\n\temail = host@example.com\n',
    );
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    expect(dockerCalls()).toHaveLength(0);
    expect(lines.join('\n')).toContain('bind-mounted ~/.gitconfig');
  });

  it('writes at system level when the mounted ~/.gitconfig has only a credential helper', async () => {
    // What `gh auth setup-git` leaves on a hub: a ~/.gitconfig with no user.*.
    await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = !gh auth git-credential\n');
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    const argv = dockerCalls()[0]!;
    expect(argv.slice(0, 4)).toEqual(['exec', '--user', 'root', 'box1']);
    expect(argv.join(' ')).toContain('git config --system user.name');
    expect(argv.slice(-2)).toEqual(['Ada Lovelace', 'ada@example.com']);
  });

  it('says so when the mounted file sets only one half, which outranks the written one', async () => {
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Host\n');
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    expect(dockerCalls()[0]!.join(' ')).toContain('--system');
    expect(lines.join('\n')).toContain('sets only one of user.name / user.email');
  });

  it("writes the generic identity when none resolved, so a checkpoint's owner is never kept", async () => {
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    const argv = dockerCalls()[0]!;
    expect(argv.join(' ')).toContain('--global');
    expect(argv.slice(-2)).toEqual(['agentbox', 'agentbox@users.noreply.github.com']);
    expect(lines.join('\n')).toContain('(from the agentbox fallback)');
  });

  it('writes nothing and says nothing when the mount decides and nothing was requested', async () => {
    await writeFile(
      join(home, '.gitconfig'),
      '[user]\n\tname = Host\n\temail = host@example.com\n',
    );
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    expect(dockerCalls()).toHaveLength(0);
    expect(lines).toEqual([]);
  });
});
