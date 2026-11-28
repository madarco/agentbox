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
const { BOX_GITCONFIG_PATH, boxGitConfigScript } = await import('../src/sync/box-gitconfig.js');

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
/** The positional args after `sh -c <script> sh`: file, include, [name, email]. */
const scriptArgs = (argv: string[]): string[] => argv.slice(argv.indexOf('-c') + 3);

describe('docker seedGitIdentity', () => {
  it('writes the requested identity into the box-owned global file, as the box user', async () => {
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    expect(dockerCalls()).toHaveLength(1);
    const argv = dockerCalls()[0]!;
    expect(argv.slice(0, 4)).toEqual(['exec', '--user', 'vscode', 'box1']);
    expect(scriptArgs(argv)).toEqual([
      BOX_GITCONFIG_PATH,
      '/home/vscode/.gitconfig',
      'Ada Lovelace',
      'ada@example.com',
    ]);
    expect(lines.join('\n')).toContain('(from the requesting machine)');
  });

  it('puts the request above a mounted ~/.gitconfig that holds a complete identity', async () => {
    // A docker create sent to an exposed hub from another device: the hub
    // owner's mounted identity must not be the one the box commits as.
    await writeFile(
      join(home, '.gitconfig'),
      '[user]\n\tname = Host\n\temail = host@example.com\n',
    );
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx());
    expect(scriptArgs(dockerCalls()[0]!).slice(-2)).toEqual(['Ada Lovelace', 'ada@example.com']);
    expect(lines.join('\n')).toContain('(from the requesting machine)');
  });

  it('lets a complete mounted identity decide when nothing was requested', async () => {
    await writeFile(
      join(home, '.gitconfig'),
      '[user]\n\tname = Host\n\temail = host@example.com\n',
    );
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    // Still rewritten (a checkpoint's [user] must go), but with no [user] of its own.
    expect(scriptArgs(dockerCalls()[0]!)).toEqual([BOX_GITCONFIG_PATH, '/home/vscode/.gitconfig']);
    expect(lines.join('\n')).toContain('bind-mounted ~/.gitconfig');
  });

  it('writes the generic identity when none resolved and the mount has none (a credential helper only)', async () => {
    await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = !gh auth git-credential\n');
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    expect(scriptArgs(dockerCalls()[0]!).slice(-2)).toEqual([
      'agentbox',
      'agentbox@users.noreply.github.com',
    ]);
    expect(lines.join('\n')).toContain('(from the agentbox fallback)');
  });

  it('replaces both halves of a mount that sets only one, so two people never mix', async () => {
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Host\n');
    await makeDockerSync({ container: 'box1' }).seedGitIdentity(ctx({ gitIdentity: undefined }));
    expect(scriptArgs(dockerCalls()[0]!).slice(-2)).toEqual([
      'agentbox',
      'agentbox@users.noreply.github.com',
    ]);
  });
});

describe('the box-owned global file, against real git precedence', () => {
  // Runs the exact script the box runs, with the two in-box paths swapped for
  // temp files, and reads the identity the way any git command in the box would.
  async function effective(
    mounted: string | null,
    identity: { name: string; email: string } | undefined,
    repoLocal?: string,
  ): Promise<{ name: string; email: string }> {
    const mountedPath = join(home, 'mounted.gitconfig');
    if (mounted !== null) await writeFile(mountedPath, mounted);
    const boxFile = join(home, 'box', 'gitconfig');
    const { script, args } = boxGitConfigScript(identity, boxFile, mountedPath);
    await realExeca('sh', ['-c', script, 'sh', ...args]);
    const repo = join(home, 'repo');
    const env = {
      GIT_CONFIG_GLOBAL: boxFile,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    await realExeca('git', ['init', '-q', repo], { env });
    if (repoLocal) await realExeca('git', ['-C', repo, 'config', 'user.email', repoLocal], { env });
    const get = async (k: string) =>
      (await realExeca('git', ['-C', repo, 'config', k], { env, reject: false })).stdout.trim();
    return { name: await get('user.name'), email: await get('user.email') };
  }
  const HOST = '[user]\n\tname = Host Owner\n\temail = host@example.com\n[alias]\n\tst = status\n';
  const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

  it('a [user] after the include beats the mounted global identity', async () => {
    expect(await effective(HOST, ADA)).toEqual(ADA);
  });

  it('without a [user], the mounted identity comes through the include', async () => {
    expect(await effective(HOST, undefined)).toEqual({
      name: 'Host Owner',
      email: 'host@example.com',
    });
  });

  it('a missing mounted file is ignored rather than an error', async () => {
    expect(await effective(null, ADA)).toEqual(ADA);
  });

  it('a repo-local identity still beats the box file, as on the host', async () => {
    expect((await effective(HOST, ADA, 'work@example.com')).email).toBe('work@example.com');
  });
});
