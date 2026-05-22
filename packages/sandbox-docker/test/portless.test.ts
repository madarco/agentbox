import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the tests never shell out to a real binary.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import {
  detectPortless,
  installPortless,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessInstallHint,
  portlessStartHint,
  portlessUnalias,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  startPortlessProxy,
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
const originalStateDir = process.env['PORTLESS_STATE_DIR'];

beforeEach(async () => {
  resetPortlessCache();
  portlessResult = ok('0.13.0'); // installed by default
  pgrepResult = fail(); // no proxy process by default
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
  if (originalStateDir === undefined) delete process.env['PORTLESS_STATE_DIR'];
  else process.env['PORTLESS_STATE_DIR'] = originalStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

describe('detectPortless', () => {
  it('reports not-installed when `portless --version` fails', async () => {
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

  it('detects a running proxy from a live proxy.pid', async () => {
    await writeFile(join(stateDir, 'proxy.pid'), String(process.pid), 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('treats a stale proxy.pid as not running', async () => {
    // PID 2^31-1 is effectively never a live process.
    await writeFile(join(stateDir, 'proxy.pid'), '2147483647', 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(false);
  });

  it('treats a foreign (root-owned) proxy.pid as running', async () => {
    // PID 1 always exists; the sudo/:443 proxy runs as root, so a non-root
    // probe gets EPERM — which still means the process is alive.
    await writeFile(join(stateDir, 'proxy.pid'), '1', 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('detects a foreground proxy via the process table when no proxy.pid exists', async () => {
    pgrepResult = ok('29219\n'); // `pgrep -f "portless proxy"` found one
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('never throws when execa rejects (binary missing)', async () => {
    portlessResult = new Error('spawn portless ENOENT');
    expect(await detectPortless()).toEqual({ installed: false, proxyRunning: false });
  });

  it('caches the result across calls', async () => {
    await detectPortless();
    await detectPortless();
    const portlessCalls = execaMock.mock.calls.filter((c) => c[0] === 'portless');
    expect(portlessCalls).toHaveLength(1);
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
});

describe('portlessBrowserEnv', () => {
  it('maps the box hostname to host.docker.internal for the in-box browser', () => {
    expect(portlessBrowserEnv('mybox')).toEqual({
      AGENT_BROWSER_ARGS: '--host-resolver-rules=MAP mybox.localhost host.docker.internal',
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
