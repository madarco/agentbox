import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PtyCarrierUnavailable,
  newManagerId,
  resolvePtyHostEntry,
  startManagerSession,
  type ManagerRecord,
  type PtyHostSpawnSpec,
} from '../src/index.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ab-carrier-'));
  cwd = await mkdtemp(join(tmpdir(), 'ab-ws-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function record(): ManagerRecord {
  const at = new Date().toISOString();
  return {
    id: newManagerId(),
    workspaceId: 'ws-carrier',
    agent: 'claude',
    kind: 'tmux',
    cwd,
    host: 'laptop',
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
  };
}

describe('resolvePtyHostEntry', () => {
  it('prefers the CLI entry the hub was spawned with', async () => {
    const entry = join(home, 'index.js');
    await writeFile(entry, '');
    await writeFile(join(home, 'pty-host.js'), '');
    expect(await resolvePtyHostEntry({ AGENTBOX_CLI_ENTRY: entry })).toBe(
      join(home, 'pty-host.js'),
    );
  });

  it('finds nothing when no install carries the host', async () => {
    const entry = join(home, 'index.js');
    await writeFile(entry, '');
    expect(await resolvePtyHostEntry({ AGENTBOX_CLI_ENTRY: entry })).toBeUndefined();
  });
});

describe('startManagerSession carrier choice', () => {
  it('starts on the pty host and registers it as a pty manager', async () => {
    const entry = join(home, 'index.js');
    await writeFile(entry, '');
    await writeFile(join(home, 'pty-host.js'), '');
    const spawned: PtyHostSpawnSpec[] = [];
    const manager = record();
    // The host normally writes its own meta; stand in for it, since spawning a
    // real one would run a real agent.
    const spawnPtyHost = async (spec: PtyHostSpawnSpec): Promise<{ pid: number }> => {
      spawned.push(spec);
      const { writePtyMeta, ptySocketPath } = await import('@agentbox/sandbox-core');
      const s = spec.spec as Record<string, string>;
      await writePtyMeta(
        {
          v: 1,
          managerId: s['managerId'] as string,
          workspaceId: s['workspaceId'] as string,
          agent: s['agent'] as string,
          cwd: s['cwd'] as string,
          socket: ptySocketPath(s['managerId'] as string, home),
          pid: 4242,
          startedAt: new Date().toISOString(),
          token: s['token'] as string,
          runId: s['runId'] as string,
          cols: 120,
          rows: 34,
          pinned: false,
          leaseGraceMs: 60_000,
        },
        home,
      );
      return { pid: 4242 };
    };
    // The readiness probe connects to the socket; a meta file alone is a
    // half-started host, so stand the liveness in as well.
    const ptyClient = await import('../src/workspaces/pty-client.js');
    vi.spyOn(ptyClient, 'ptyHostAlive').mockResolvedValue(true);

    const registration = await startManagerSession({
      wsId: 'ws-carrier',
      manager,
      argv: ['claude'],
      env: { AGENTBOX_CLI_ENTRY: entry, SHELL: '/bin/zsh' },
      hostname: () => 'laptop',
      spawnPtyHost,
      ptyBaseDir: home,
    });

    expect(registration.kind).toBe('pty');
    expect(registration.pty?.runId).toMatch(/^[0-9a-f]{32}$/u);
    expect(registration.tmuxSession).toBeUndefined();
    // The launch script never rides in argv, where `ps` would show the token.
    expect(spawned[0]?.entry).toBe(join(home, 'pty-host.js'));
    expect(JSON.stringify(spawned[0]?.spec)).toContain('AGENTBOX_MANAGER_RUN');
  });

  it('falls back to tmux when no pty host can run, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: { file: string; args: string[] }[] = [];
    const registration = await startManagerSession({
      wsId: 'ws-carrier',
      manager: record(),
      argv: ['claude'],
      env: { SHELL: '/bin/zsh' },
      hostname: () => 'laptop',
      exec: async (file, args) => {
        calls.push({ file, args });
        return { exitCode: 0, stdout: '' };
      },
      ptyBaseDir: home,
    });
    expect(registration.kind).toBe('tmux');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['new-session', '-d']);
    expect(warn.mock.calls[0]?.[0]).toMatch(/pty carrier unavailable/u);
  });

  it('refuses rather than falling back when the carrier was named', async () => {
    await expect(
      startManagerSession({
        wsId: 'ws-carrier',
        manager: record(),
        argv: ['claude'],
        carrier: 'pty',
        env: { SHELL: '/bin/zsh' },
        hostname: () => 'laptop',
        ptyBaseDir: home,
      }),
    ).rejects.toBeInstanceOf(PtyCarrierUnavailable);
  });

  it('never touches the pty carrier when tmux was named', async () => {
    const entry = join(home, 'index.js');
    await writeFile(entry, '');
    await writeFile(join(home, 'pty-host.js'), '');
    const spawnPtyHost = vi.fn();
    const registration = await startManagerSession({
      wsId: 'ws-carrier',
      manager: record(),
      argv: ['claude'],
      carrier: 'tmux',
      env: { AGENTBOX_CLI_ENTRY: entry, SHELL: '/bin/zsh' },
      hostname: () => 'laptop',
      exec: async () => ({ exitCode: 0, stdout: '' }),
      spawnPtyHost,
      ptyBaseDir: home,
    });
    expect(registration.kind).toBe('tmux');
    expect(spawnPtyHost).not.toHaveBeenCalled();
  });
});
