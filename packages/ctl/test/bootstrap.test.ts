import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cloneWorkspace, runBootstrap, type BootstrapDeps, type BootstrapEnv } from '../src/commands/bootstrap.js';

/** A spy-able deps object; everything live by default, records launch calls. */
function makeDeps(over: Partial<BootstrapDeps> = {}): BootstrapDeps & {
  calls: { dockerd: number; ctl: number; vnc: number; clone: number };
} {
  const calls = { dockerd: 0, ctl: 0, vnc: 0, clone: 0 };
  const base: BootstrapDeps = {
    isCtlDaemonLive: async () => false,
    isDockerdLive: async () => false,
    isVncLive: async () => false,
    isWorkspacePopulated: async () => false,
    cloneWorkspace: async () => {
      calls.clone++;
    },
    ensureRuntimeDirs: async () => {},
    launchDockerd: async () => {
      calls.dockerd++;
    },
    waitDockerdReady: async () => true,
    launchCtlDaemon: () => {
      calls.ctl++;
    },
    waitCtlDaemonReady: async () => true,
    launchVnc: async () => {
      calls.vnc++;
    },
    log: () => {},
  };
  return Object.assign(base, over, { calls });
}

const VNC_ENV: BootstrapEnv = { AGENTBOX_VNC_PASSWORD: 'pw' };

describe('runBootstrap idempotency', () => {
  it('launches every daemon when all are dead', async () => {
    const deps = makeDeps();
    const r = await runBootstrap(VNC_ENV, deps);
    expect(deps.calls).toEqual({ dockerd: 1, ctl: 1, vnc: 1, clone: 0 });
    expect(r).toMatchObject({ dockerd: 'up', ctl: 'up', vnc: 'up' });
  });

  it('skips every daemon when all are already live (resume / Vercel persistent snapshot)', async () => {
    const deps = makeDeps({
      isCtlDaemonLive: async () => true,
      isDockerdLive: async () => true,
      isVncLive: async () => true,
    });
    const r = await runBootstrap(VNC_ENV, deps);
    expect(deps.calls).toEqual({ dockerd: 0, ctl: 0, vnc: 0, clone: 0 });
    expect(r).toMatchObject({ dockerd: 'skipped', ctl: 'already', vnc: 'skipped' });
  });

  it('only relaunches the dead daemon (ctl dead, others live)', async () => {
    const deps = makeDeps({
      isDockerdLive: async () => true,
      isVncLive: async () => true,
    });
    const r = await runBootstrap(VNC_ENV, deps);
    expect(deps.calls).toEqual({ dockerd: 0, ctl: 1, vnc: 0, clone: 0 });
    expect(r.ctl).toBe('up');
  });

  it('respects AGENTBOX_LAUNCH_DOCKERD=0 and AGENTBOX_VNC_ENABLED=0', async () => {
    const deps = makeDeps();
    const r = await runBootstrap(
      { AGENTBOX_LAUNCH_DOCKERD: '0', AGENTBOX_VNC_ENABLED: '0', AGENTBOX_VNC_PASSWORD: 'pw' },
      deps,
    );
    expect(deps.calls).toEqual({ dockerd: 0, ctl: 1, vnc: 0, clone: 0 });
    expect(r).toMatchObject({ dockerd: 'disabled', vnc: 'disabled' });
  });

  it('treats VNC as disabled when no password is provided', async () => {
    const deps = makeDeps();
    const r = await runBootstrap({}, deps);
    expect(deps.calls.vnc).toBe(0);
    expect(r.vnc).toBe('disabled');
  });

  it('reports ctl failed when the daemon never comes ready', async () => {
    const deps = makeDeps({ waitCtlDaemonReady: async () => false });
    const r = await runBootstrap(VNC_ENV, deps);
    expect(r.ctl).toBe('failed');
  });

  it('clones when AGENTBOX_CLONE_URL is set and workspace is empty', async () => {
    const deps = makeDeps({ isWorkspacePopulated: async () => false });
    const r = await runBootstrap(
      { ...VNC_ENV, AGENTBOX_CLONE_URL: 'https://x@github.com/a/b.git', AGENTBOX_ORIGIN_URL: 'https://github.com/a/b.git' },
      deps,
    );
    expect(deps.calls.clone).toBe(1);
    expect(r.cloned).toBe(true);
  });

  it('skips the clone when workspace is already populated (host-seed)', async () => {
    const deps = makeDeps({ isWorkspacePopulated: async () => true });
    const r = await runBootstrap(
      { ...VNC_ENV, AGENTBOX_CLONE_URL: 'https://x@github.com/a/b.git', AGENTBOX_ORIGIN_URL: 'https://github.com/a/b.git' },
      deps,
    );
    expect(deps.calls.clone).toBe(0);
    expect(r.cloned).toBe(false);
  });
});

/** Real git, bypassing the box's `/usr/local/bin/git` shim. Absent on some hosts. */
const REAL_GIT = '/usr/bin/git';

describe('cloneWorkspace', () => {
  let dir: string;
  let bare: string;
  let dest: string;
  const originalEnv = { ...process.env };
  const originalPath = process.env.PATH ?? '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbox-bootstrap-'));
    const src = join(dir, 'src');
    bare = join(dir, 'origin.git');
    dest = join(dir, 'workspace');

    // Run this suite inside an agentbox box and plain `git` on PATH is the shim,
    // which intercepts `clone` and routes it at the (absent) host relay. Both the
    // fixture and cloneWorkspace itself spawn `git` from PATH, so put real git in
    // front for the duration of the test. Outside a box this is a no-op.
    if (existsSync(REAL_GIT)) {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      symlinkSync(REAL_GIT, join(binDir, 'git'));
      process.env.PATH = `${binDir}${delimiter}${originalPath}`;
    }
    // A box bind-mounts the host ~/.gitconfig, whose commit.gpgsign +
    // user.signingkey name a host key path that does not exist here, so the
    // fixture's `git commit` fails. Same guard the shim tests use. Identity comes
    // from the explicit `git config` calls below.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';

    const git = (args: string[], cwd?: string) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(['init', '-q', src]);
    git(['-C', src, 'config', 'user.email', 't@t']);
    git(['-C', src, 'config', 'user.name', 't']);
    execFileSync('sh', ['-c', 'echo hi > readme.md'], { cwd: src });
    git(['-C', src, 'add', '.']);
    git(['-C', src, 'commit', '-q', '-m', 'init']);
    git(['clone', '-q', '--bare', src, bare]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('clones the authed URL then scrubs origin back to the bare URL', async () => {
    const originUrl = 'https://github.com/acme/widgets.git';
    await cloneWorkspace({
      cloneUrl: `file://${bare}`,
      originUrl,
      workspaceDir: dest,
    });
    const remote = execFileSync('git', ['-C', dest, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
    expect(remote).toBe(originUrl);
    // The working tree materialized.
    const head = execFileSync('git', ['-C', dest, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    }).trim();
    expect(head).toBe('true');
  });
});
