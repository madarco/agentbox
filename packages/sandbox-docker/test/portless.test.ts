import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the tests never shell out to a real binary.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

// Liveness asks candidate ports whether a Portless proxy answers; that probe is
// replaced per test so the result never depends on the developer's machine.
const liveModes = new Set<number>();

import { existsSync } from 'node:fs';

import {
  detectPortless,
  ensurePortlessForUrl,
  ensurePortlessProxy,
  livePortlessUrl,
  portlessCmd,
  resetPortlessCmdForTests,
  setPortlessAnswerProbeForTests,
  installPortless,
  installPortlessServiceDetailed,
  sudoIdentityEnvPrefix,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessInstallHint,
  portlessServiceHint,
  portlessServiceStatus,
  portlessStartHint,
  portlessDoctorRow,
  portlessUnalias,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  serviceLogShowsConflict,
  startPortlessProxy,
  PORTLESS_PROXY_PORT,
} from '../src/portless.js';

interface ExecaResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

const ok = (stdout = ''): ExecaResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecaResult => ({ exitCode: 1, stdout: '', stderr });

// Per-command execa stubs. `detectPortless` shells out to `portless --version`
// and `pgrep`; the alias/get helpers shell out to `portless`. Tests set these.
let portlessResult: ExecaResult | Error;
let pgrepResult: ExecaResult;

let stateDir: string;
let binDir: string;
const originalStateDir = process.env['PORTLESS_STATE_DIR'];
const originalPath = process.env['PATH'];

beforeEach(async () => {
  resetPortlessCache();
  portlessResult = ok('0.13.0'); // installed by default
  pgrepResult = fail(); // no proxy process by default
  liveModes.clear(); // no proxy answering by default
  setPortlessAnswerProbeForTests(async (m) => liveModes.has(m.port));
  // A `portless` on PATH, so the command stays the bare name the assertions use.
  binDir = await mkdtemp(join(tmpdir(), 'agentbox-portless-bin-'));
  await writeFile(join(binDir, 'portless'), '#!/bin/sh\n', { mode: 0o755 });
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
  resetPortlessCmdForTests();
  execaMock.mockReset();
  execaMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'pgrep') return pgrepResult;
    if (portlessResult instanceof Error) throw portlessResult;
    return portlessResult;
  });
  // Point the proxy-liveness probe at an empty dir so the proxy.pid path
  // reports nothing unless a test writes one in.
  stateDir = await mkdtemp(join(tmpdir(), 'agentbox-portless-test-'));
  process.env['PORTLESS_STATE_DIR'] = stateDir;
});

afterEach(async () => {
  resetPortlessCache();
  setPortlessAnswerProbeForTests(null);
  process.env['PATH'] = originalPath;
  resetPortlessCmdForTests();
  await rm(binDir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env['PORTLESS_STATE_DIR'];
  else process.env['PORTLESS_STATE_DIR'] = originalStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

describe('detectPortless', () => {
  it('reports not-installed when `portless --version` fails and no proxy answers', async () => {
    portlessResult = fail();
    expect(await detectPortless()).toEqual({ installed: false, proxyRunning: false });
  });

  it('reports installed and captures the version', async () => {
    portlessResult = ok('0.9.1');
    const r = await detectPortless();
    expect(r.installed).toBe(true);
    expect(r.version).toBe('0.9.1');
    expect(r.proxyRunning).toBe(false);
  });

  it('sees a live proxy and its mode even when the CLI is unreachable', async () => {
    // The hub under launchd / the tray: no nvm on PATH, the :443 proxy up.
    portlessResult = new Error('spawn portless ENOENT');
    liveModes.add(443);
    expect(await detectPortless()).toEqual({
      installed: true,
      proxyRunning: true,
      mode: { port: 443, tls: true },
    });
  });

  it('prefers the mode the CLI says is configured', async () => {
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (Array.isArray(args) && args[0] === 'get') return ok('http://x.localhost:8099');
      return portlessResult as ExecaResult;
    });
    liveModes.add(8099);
    liveModes.add(1355);
    expect((await detectPortless()).mode).toEqual({ port: 8099, tls: false });
  });

  it('does not take a pid file alone for a live proxy', async () => {
    // launchd's foreground proxy writes no pid, so ~/.portless/proxy.pid can hold
    // a dead (or reused, EPERM) pid while nothing listens.
    await writeFile(join(stateDir, 'proxy.pid'), '1', 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(false);
  });

  it('never throws when execa rejects (binary missing)', async () => {
    portlessResult = new Error('spawn portless ENOENT');
    expect(await detectPortless()).toEqual({ installed: false, proxyRunning: false });
  });

  it('caches the result across calls', async () => {
    await detectPortless();
    await detectPortless();
    const versionCalls = execaMock.mock.calls.filter(
      (c) => c[0] === 'portless' && Array.isArray(c[1]) && c[1][0] === '--version',
    );
    expect(versionCalls).toHaveLength(1);
  });
});

describe('portlessAlias / portlessUnalias', () => {
  it('portlessAlias returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await portlessAlias('mybox', 54321)).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('portless', ['alias', 'mybox', '54321'], {
      reject: false,
    });
  });

  it('portlessAlias returns false on non-zero exit', async () => {
    portlessResult = fail('duplicate route');
    expect(await portlessAlias('mybox', 54321)).toBe(false);
  });

  it('portlessAlias never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessAlias('mybox', 54321)).toBe(false);
  });

  it('portlessUnalias returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await portlessUnalias('mybox')).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('portless', ['alias', '--remove', 'mybox'], {
      reject: false,
    });
  });

  it('portlessUnalias never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessUnalias('mybox')).toBe(false);
  });
});

describe('portlessGetUrl', () => {
  it('returns the URL printed by `portless get`', async () => {
    portlessResult = ok('https://mybox.localhost\n');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back to the deterministic URL on non-zero exit', async () => {
    portlessResult = fail('unknown route');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back when stdout is not a URL', async () => {
    portlessResult = ok('not a url');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('discards a worktree-scoped answer and composes from the proxy mode', async () => {
    // Run inside a git worktree, `portless get mybox` answers with the name it
    // would give a dev server started there — not the static route we asked
    // about. Trusting it would make a box's URL depend on the caller's cwd.
    let call = 0;
    execaMock.mockImplementation(async (_cmd: string, args?: readonly string[]) => {
      if (Array.isArray(args) && args[0] === 'get') {
        call += 1;
        return call === 1
          ? ok('http://my-worktree.mybox.localhost:1355') // the cwd-scoped answer
          : ok('http://probe.localhost:1355'); // the mode probe
      }
      return portlessResult as ExecaResult;
    });
    expect(await portlessGetUrl('mybox')).toBe('http://mybox.localhost:1355');
  });

  it('omits the port when the proxy serves the scheme default', async () => {
    execaMock.mockImplementation(async (_cmd: string, args?: readonly string[]) => {
      if (Array.isArray(args) && args[0] === 'get') return ok('https://wt.mybox.localhost');
      return portlessResult as ExecaResult;
    });
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });
});

describe('portlessBrowserEnv', () => {
  it('maps the box hostname to host.docker.internal for docker (mapTarget option)', () => {
    expect(portlessBrowserEnv('mybox', { mapTarget: 'host.docker.internal' })).toEqual({
      AGENT_BROWSER_ARGS: '--host-resolver-rules=MAP mybox.localhost host.docker.internal',
      AGENT_BROWSER_IGNORE_HTTPS_ERRORS: '1',
    });
  });

  it('maps to 127.0.0.1 for hetzner (box is the VPS, WebProxy on loopback)', () => {
    expect(portlessBrowserEnv('mybox', { mapTarget: '127.0.0.1' })).toEqual({
      AGENT_BROWSER_ARGS: '--host-resolver-rules=MAP mybox.localhost 127.0.0.1',
      AGENT_BROWSER_IGNORE_HTTPS_ERRORS: '1',
    });
  });
});

describe('hints', () => {
  it('install hint points at npm', () => {
    expect(portlessInstallHint()).toBe('npm install -g portless');
  });

  it('start hint starts the proxy', () => {
    expect(portlessStartHint()).toBe('portless proxy start');
  });
});

describe('installPortless / startPortlessProxy', () => {
  it('installPortless runs `npm install -g portless` and returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await installPortless()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('npm', ['install', '-g', 'portless'], {
      reject: false,
    });
  });

  it('installPortless returns false on non-zero exit', async () => {
    portlessResult = fail();
    expect(await installPortless()).toBe(false);
  });

  it('installPortless never throws when execa rejects', async () => {
    portlessResult = new Error('npm not found');
    expect(await installPortless()).toBe(false);
  });

  it('startPortlessProxy starts a no-TLS proxy on the no-root port', async () => {
    portlessResult = ok();
    expect(await startPortlessProxy()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', '1355'],
      { reject: false },
    );
  });

  it('startPortlessProxy never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await startPortlessProxy()).toBe(false);
  });
});

describe('sudoIdentityEnvPrefix', () => {
  it('names the invoking user so Portless chowns its state back to them', () => {
    expect(sudoIdentityEnvPrefix({ uid: 501, gid: 20, username: 'jo' })).toBe(
      "SUDO_USER='jo' SUDO_UID=501 SUDO_GID=20 ",
    );
  });

  it('quotes a username the shell would word-split', () => {
    expect(sudoIdentityEnvPrefix({ uid: 501, gid: 20, username: 'jo smith' })).toBe(
      "SUDO_USER='jo smith' SUDO_UID=501 SUDO_GID=20 ",
    );
  });

  it('says nothing when already root', () => {
    expect(sudoIdentityEnvPrefix({ uid: 0, gid: 0, username: 'root' })).toBe('');
  });
});

describe('installPortlessServiceDetailed', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  // Without this, Portless resolves uid/gid 0 under `osascript … with administrator
  // privileges` (no SUDO_* the way sudo sets them), bakes SUDO_UID=0 into the
  // LaunchDaemon, and the boot proxy chowns the user's ~/.portless to root:wheel.
  it('carries the invoking user into the elevated install', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    portlessResult = ok();
    await installPortlessServiceDetailed();
    const call = execaMock.mock.calls.find((c) => c[0] === 'osascript');
    const script = String((call?.[1] as string[] | undefined)?.[1] ?? '');
    const who = sudoIdentityEnvPrefix();
    expect(script).toContain(`${who}'portless' service install`);
    expect(script).toContain(`${who}'portless' trust`);
  });
});

describe('resolvePortlessHostStateDir', () => {
  it('an explicit override wins outright', async () => {
    expect(await resolvePortlessHostStateDir('/custom/portless')).toBe('/custom/portless');
  });

  it('falls back to $PORTLESS_STATE_DIR when no override is given', async () => {
    // beforeEach sets PORTLESS_STATE_DIR to the temp stateDir.
    expect(await resolvePortlessHostStateDir()).toBe(stateDir);
  });

  it('returns an absolute path when nothing is configured', async () => {
    delete process.env['PORTLESS_STATE_DIR'];
    const r = await resolvePortlessHostStateDir();
    expect(r.startsWith('/')).toBe(true);
  });
});

describe('detectPortless probe sharing', () => {
  it('runs one probe for concurrent callers', async () => {
    execaMock.mockImplementation(async () => ok('0.13.0'));
    resetPortlessCache();
    await Promise.all([detectPortless(), detectPortless(), detectPortless()]);
    const versionCalls = execaMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === '--version',
    );
    expect(versionCalls).toHaveLength(1);
  });
});

describe('portlessCmd', () => {
  it('finds the CLI next to the running Node when it is not on PATH', async () => {
    // The hub's PATH (launchd, the tray) lacks nvm; `npm i -g` put portless
    // beside the node binary that runs the hub.
    process.env['PATH'] = '/nonexistent';
    resetPortlessCmdForTests();
    const realHome = process.env['HOME'];
    process.env['HOME'] = stateDir; // nothing remembered there
    const realExecPath = process.execPath;
    process.execPath = join(binDir, 'node'); // binDir holds an executable `portless`
    try {
      expect(await portlessCmd()).toBe(join(binDir, 'portless'));
    } finally {
      process.execPath = realExecPath;
      process.env['HOME'] = realHome;
    }
  });

  it('prefers the path a shell remembered over the Node bin dir', async () => {
    process.env['PATH'] = '/nonexistent';
    resetPortlessCmdForTests();
    const realHome = process.env['HOME'];
    process.env['HOME'] = stateDir;
    try {
      await mkdir(join(stateDir, '.agentbox'), { recursive: true });
      await writeFile(join(stateDir, '.agentbox', 'portless-bin'), `${join(binDir, 'portless')}\n`);
      expect(await portlessCmd()).toBe(join(binDir, 'portless'));
    } finally {
      process.env['HOME'] = realHome;
    }
  });

  it('uses the bare name when portless is on PATH', async () => {
    expect(await portlessCmd()).toBe('portless');
  });
});

describe('livePortlessUrl', () => {
  it('composes the alias from the live mode, not a recorded URL', () => {
    expect(livePortlessUrl('b', { port: 443, tls: true })).toBe('https://b.localhost');
    expect(livePortlessUrl('b', { port: 1355, tls: false })).toBe('http://b.localhost:1355');
  });

  it('is undefined with no live proxy or no alias', () => {
    expect(livePortlessUrl('b', null)).toBeUndefined();
    expect(livePortlessUrl(undefined, { port: 443, tls: true })).toBeUndefined();
  });
});

describe('portlessDoctorRow', () => {
  it('warns with the install hint when Portless is not installed', () => {
    const row = portlessDoctorRow({ installed: false, proxyRunning: false });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('not installed');
    // The whole setup (CLI + boot service + portless.enabled), not just the npm install.
    expect(row.hint).toContain('agentbox install portless');
  });

  it('warns with the start hint when installed but the proxy is down', () => {
    const row = portlessDoctorRow({ installed: true, version: '0.13.0', proxyRunning: false });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('proxy not running');
    expect(row.hint).toContain(portlessStartHint());
  });

  it('is ok and shows the version when the proxy is running', () => {
    const row = portlessDoctorRow({ installed: true, version: '0.13.0', proxyRunning: true });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('0.13.0');
    expect(row.hint).toBeUndefined();
  });

  it('is ok without a version string when none was reported', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true });
    expect(row.status).toBe('ok');
    expect(row.detail).toBe('running');
  });

  it('stays ok but flags a running proxy with no OS service', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true }, { installed: false });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain("won't survive a reboot");
    expect(row.hint).toContain(portlessServiceHint());
  });

  it('says nothing extra when the OS service is installed', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true }, { installed: true });
    expect(row.detail).toBe('running');
    expect(row.hint).toBeUndefined();
  });

  it('warns when the startup service is installed but crash-looping', () => {
    const row = portlessDoctorRow(
      { installed: true, proxyRunning: true },
      { installed: true, failing: true },
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('startup service failing');
  });
});

describe('portlessServiceStatus', () => {
  it('parses `Installed: yes`', async () => {
    portlessResult = ok(
      [
        'portless service',
        '  Manager state: running',
        '  Installed: yes',
        '  Proxy on 443: responding',
      ].join('\n'),
    );
    expect(await portlessServiceStatus()).toEqual({ installed: true });
    expect(execaMock).toHaveBeenCalledWith('portless', ['service', 'status'], { reject: false });
  });

  it('parses `Installed: no`', async () => {
    portlessResult = ok(['portless service', '  Installed: no'].join('\n'));
    expect(await portlessServiceStatus()).toEqual({ installed: false });
  });

  it('reports not-installed when the output has no Installed line', async () => {
    // A future Portless could reword this; the fallback must not claim a
    // service exists, since that only suppresses a nudge.
    portlessResult = ok('something else entirely');
    expect((await portlessServiceStatus()).installed).toBe(
      process.platform === 'darwin'
        ? existsSync('/Library/LaunchDaemons/sh.portless.proxy.plist')
        : false,
    );
  });

  it('never throws when the binary is missing', async () => {
    portlessResult = new Error('spawn portless ENOENT');
    await expect(portlessServiceStatus()).resolves.toBeDefined();
  });

  const conflict = [
    'Proxy is already running on port 443 with a different config.',
    '- requested HTTPS, but the running proxy is using HTTP',
    'Stop it first, then restart with the desired settings:',
    '  sudo portless proxy stop',
    '  sudo portless proxy start --https',
  ].join('\n');

  const statusWith = (dir: string) =>
    ok(['portless service', '  Installed: yes', `  State directory: ${dir}`].join('\n'));

  it('reports a crash-looping service from its log', async () => {
    await writeFile(join(stateDir, 'service.log'), conflict + '\n');
    portlessResult = statusWith(stateDir);
    expect(await portlessServiceStatus()).toEqual({ installed: true, failing: true });
  });

  it('ignores conflict lines older than the given moment', async () => {
    await writeFile(join(stateDir, 'service.log'), conflict + '\n');
    portlessResult = statusWith(stateDir);
    const later = Date.now() + 1000;
    expect(await portlessServiceStatus({ sinceMs: later })).toEqual({ installed: true });
  });

  it('is healthy when the log has no conflict', async () => {
    await writeFile(join(stateDir, 'service.log'), 'proxy started on 443\n');
    portlessResult = statusWith(stateDir);
    expect(await portlessServiceStatus()).toEqual({ installed: true });
  });
});

describe('serviceLogShowsConflict', () => {
  const now = 1_000_000;
  const line = 'Proxy is already running on port 443 with a different config.';

  it('needs the conflict among the last lines of a recently written log', () => {
    expect(serviceLogShowsConflict(line, now - 5_000, now)).toBe(true);
    expect(serviceLogShowsConflict(line, now - 120_000, now)).toBe(false);
    expect(serviceLogShowsConflict(`${line}\n` + 'ok\n'.repeat(10), now - 5_000, now)).toBe(false);
  });

  it('honors sinceMs', () => {
    expect(serviceLogShowsConflict(line, now - 5_000, now, now - 1_000)).toBe(false);
    expect(serviceLogShowsConflict(line, now - 500, now, now - 1_000)).toBe(true);
  });
});

describe('ensurePortlessProxy', () => {
  // `portless get` is how the configured mode is read; default it to the
  // no-root http mode so most tests exercise the silent restart path.
  const configuredMode = (url: string): void => {
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (cmd === 'pgrep') return pgrepResult;
      if (Array.isArray(args) && args[0] === 'get') return ok(url);
      if (portlessResult instanceof Error) throw portlessResult;
      return portlessResult;
    });
  };

  beforeEach(() => {
    configuredMode('http://x.localhost:1355');
  });

  it('does nothing when Portless is not installed', async () => {
    portlessResult = fail();
    const state = await ensurePortlessProxy();
    expect(state).toEqual({ installed: false, proxyRunning: false });
    expect(execaMock.mock.calls.some((c) => Array.isArray(c[1]) && c[1][0] === 'proxy')).toBe(
      false,
    );
  });

  it('does nothing when a proxy is already running', async () => {
    liveModes.add(1355);
    const state = await ensurePortlessProxy();
    expect(state.proxyRunning).toBe(true);
    expect(execaMock.mock.calls.some((c) => Array.isArray(c[1]) && c[1][0] === 'proxy')).toBe(
      false,
    );
  });

  it('restarts the no-root proxy on the port the host already uses', async () => {
    configuredMode('http://x.localhost:1355');
    await ensurePortlessProxy();
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', String(PORTLESS_PROXY_PORT)],
      { reject: false },
    );
  });

  it('keeps a non-default no-root port rather than resetting it to 1355', async () => {
    // Switching ports rewrites every <box>.localhost URL — the box mirrors the
    // host proxy's mode, so a silent change desyncs the two sides.
    configuredMode('http://x.localhost:8099');
    await ensurePortlessProxy();
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', '8099'],
      { reject: false },
    );
  });

  it('refuses to downgrade an https host to the no-TLS port without a password prompt', async () => {
    // The host serves https://<box>.localhost; coming back on :1355 would break
    // every URL written against it (in-box mirror, {{AGENTBOX_BOX_HOST}}).
    configuredMode('https://x.localhost');
    const state = await ensurePortlessProxy({ allowRootPrompt: false });
    expect(state.proxyRunning).toBe(false);
    expect(execaMock.mock.calls.some((c) => Array.isArray(c[1]) && c[1][0] === 'proxy')).toBe(
      false,
    );
    expect(execaMock.mock.calls.some((c) => c[0] === 'osascript')).toBe(false);
  });

  it('ensurePortlessForUrl: no proxy without a password means loopback, said once', async () => {
    configuredMode('https://x.localhost');
    const warn = vi.fn();
    expect(await ensurePortlessForUrl(warn)).toBeNull();
    resetPortlessCache();
    expect(await ensurePortlessForUrl(warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('agentbox install portless');
    expect(execaMock.mock.calls.some((c) => c[0] === 'osascript')).toBe(false);
  });

  it('ensurePortlessForUrl: restarts a no-root proxy and reports the alias usable', async () => {
    configuredMode('http://x.localhost:1355');
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (Array.isArray(args) && args[0] === 'get') return ok('http://x.localhost:1355');
      if (Array.isArray(args) && args[0] === 'proxy') {
        liveModes.add(1355); // the started proxy now answers on its port
        return ok('');
      }
      return portlessResult as ExecaResult;
    });
    expect(await ensurePortlessForUrl()).toEqual({ port: 1355, tls: false });
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', String(PORTLESS_PROXY_PORT)],
      { reject: false },
    );
  });

  it('starts nothing unasked on a host that has never run a proxy', async () => {
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (cmd === 'pgrep') return pgrepResult;
      if (Array.isArray(args) && args[0] === 'get') return fail(); // no route registry yet
      return portlessResult as ExecaResult;
    });
    const state = await ensurePortlessProxy({ allowRootPrompt: false });
    expect(state.proxyRunning).toBe(false);
    expect(execaMock.mock.calls.some((c) => Array.isArray(c[1]) && c[1][0] === 'proxy')).toBe(
      false,
    );
  });

  it('with allowModeChange:false, a refused :443 start does not fall back to :1355', async () => {
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (Array.isArray(args) && args[0] === 'get') return ok('https://x.localhost');
      if (cmd === 'osascript') return { exitCode: 1, stdout: '', stderr: 'User canceled. (-128)' };
      if (Array.isArray(args) && args[0] === 'proxy') return fail('refused');
      return portlessResult as ExecaResult;
    });
    const state = await ensurePortlessProxy({ allowRootPrompt: true, allowModeChange: false });
    expect(state.proxyRunning).toBe(false);
    expect(execaMock.mock.calls.some((c) => Array.isArray(c[1]) && c[1].includes('--no-tls'))).toBe(
      false,
    );
  });

  it('never asks for a password unless allowRootPrompt is set', async () => {
    await ensurePortlessProxy();
    expect(execaMock.mock.calls.some((c) => c[0] === 'osascript')).toBe(false);
  });

  it('reports the proxy as running once the start succeeds', async () => {
    // The post-start re-probe is what tells the caller it worked, so simulate a
    // proxy that starts answering on its port.
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (cmd === 'pgrep') return pgrepResult;
      if (Array.isArray(args) && args[0] === 'get') return ok('http://x.localhost:1355');
      if (Array.isArray(args) && args[0] === 'proxy' && args[1] === 'start') {
        liveModes.add(1355);
        return ok();
      }
      return portlessResult as ExecaResult;
    });
    expect((await ensurePortlessProxy()).proxyRunning).toBe(true);
  });
});
