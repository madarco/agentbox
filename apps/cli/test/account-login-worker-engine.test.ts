import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerRun } from '@agentbox/sandbox-docker';

// Scratch HOME before the imports: the account store is read from it.
const home = mkdtempSync(join(tmpdir(), 'agentbox-worker-engine-'));
const realHome = process.env.HOME;
process.env.HOME = home;
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const runAgentLogin = vi.fn();
vi.mock('@agentbox/cli-kit', async (orig) => ({
  ...(await orig<typeof import('@agentbox/cli-kit')>()),
  runAgentLogin: (o: unknown) => runAgentLogin(o),
}));
const storeDefaultLogin = vi.fn().mockResolvedValue(true);
const writeVolumeFileAtomic = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/lib/login-fanout.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/login-fanout.js')>()),
  storeDefaultLogin: (...a: unknown[]) => storeDefaultLogin(...a),
  writeVolumeFileAtomic: (...a: unknown[]) => writeVolumeFileAtomic(...a),
}));
const captureVolumeLogin = vi.fn().mockResolvedValue({ written: true, reason: 'stored' });
vi.mock('@agentbox/sandbox-docker', async (orig) => ({
  ...(await orig<typeof import('@agentbox/sandbox-docker')>()),
  captureVolumeLogin: (...a: unknown[]) => captureVolumeLogin(...a),
}));
vi.mock('../src/commands/control-plane.js', () => ({
  syncAgentCredentialsIfChanged: () => Promise.resolve(),
}));

const { signInAndStore } = await import('../src/commands/_account-login-worker.js');
const { hubSigninEngine } = await import('../src/lib/signin-engine.js');
type SigninEngine = import('../src/lib/signin-engine.js').SigninEngine;
type AgentCliSpec = import('@agentbox/cli-kit').AgentCliSpec;

const LOGIN = JSON.stringify({ tokens: { refresh_token: 'rt' } });
const b64 = (s: string): string => Buffer.from(s).toString('base64');

/** A fake engine: reads see no login until the login ran, then `LOGIN`. */
function fakeEngine(where: 'local' | 'hub'): { engine: SigninEngine; argvs: string[][] } {
  const argvs: string[][] = [];
  let loggedIn = false;
  runAgentLogin.mockImplementation(() => {
    loggedIn = true;
    return Promise.resolve({ ok: true });
  });
  const run: DockerRun = (argv) => {
    argvs.push(argv);
    // The worker's volume read: `sh -c <script> sh <rel…>`.
    const rels = argv.slice(argv.lastIndexOf('sh') + 1);
    const stdout = rels.map((r) => `${r}\t${loggedIn ? b64(LOGIN) : '-'}`).join('\n');
    return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
  };
  const base = hubSigninEngine({
    alias: 'hub',
    run,
    ttyCommand: (a) => ({ file: 'ssh', args: ['-tt', 'root@h', ...a] }),
    ensureAgentImage: () => Promise.resolve('agentbox/box:feedfacefeedface'),
  });
  return {
    engine: where === 'hub' ? base : { ...base, where, hostsAccountVolumes: true },
    argvs,
  };
}

const resetAccountVolume = vi.fn().mockResolvedValue(undefined);
const loginBinding = vi.fn((o: { image: string; volume?: string; docker?: DockerRun }) => ({
  spec: {} as never,
  dockerArgv: ['run', '-it', '--rm', '-v', `${o.volume}:/x`, o.image, 'codex', 'login'],
  verify: () => Promise.resolve(true),
}));
const codex = {
  id: 'codex',
  shortName: 'codex',
  runtime: {
    supportsAccountLogin: true,
    loginBinding,
    resetAccountVolume,
    sharedVolume: 'agentbox-codex-config',
  },
} as unknown as AgentCliSpec;

function ctx(engine: SigninEngine) {
  return {
    setState: () => {},
    sessionId: '0123456789abcdef',
    log: { write: () => {}, raw: () => {}, close: () => {} } as never,
    signal: new AbortController().signal,
    committing: { value: false },
    scratch: { value: null as string | null },
    engine,
  };
}
const req = (account: string) => ({
  agent: 'codex',
  account,
  mode: 'add' as const,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a hub sign-in on the control box engine', () => {
  it('runs the login over the engine, in a container named after its scratch volume', async () => {
    const { engine } = fakeEngine('hub');
    const c = ctx(engine);
    await signInAndStore(codex, req('default'), c);
    expect(c.scratch.value).toBe('agentbox-codex-config-signin-0123456789abcdef');
    const opts = runAgentLogin.mock.calls[0]![0] as { command?: { file: string; args: string[] } };
    expect(opts.command?.file).toBe('ssh');
    expect(opts.command?.args).toEqual(
      expect.arrayContaining(['run', '--name', 'agentbox-codex-config-signin-0123456789abcdef']),
    );
    // The binding's own checks run on the engine too.
    expect(loginBinding.mock.calls[0]![0].docker).toBe(engine.run);
  });

  it('stores the default login in the backup only: no shared volume, no reset', async () => {
    const { engine } = fakeEngine('hub');
    await signInAndStore(codex, req('default'), ctx(engine));
    expect(storeDefaultLogin).toHaveBeenCalledWith('codex', expect.any(String), LOGIN, {
      volume: false,
    });
    expect(resetAccountVolume).not.toHaveBeenCalled();
  });

  it("stores a named login in the account store only: never the account's volume", async () => {
    const { engine } = fakeEngine('hub');
    await signInAndStore(codex, req('work'), ctx(engine));
    expect(captureVolumeLogin).toHaveBeenCalledTimes(1);
    expect(writeVolumeFileAtomic).not.toHaveBeenCalled();
    expect(resetAccountVolume).not.toHaveBeenCalled();
  });
});

describe('a hub sign-in on local docker (unchanged)', () => {
  it('still writes the stored login into the volumes its boxes mount', async () => {
    const { engine } = fakeEngine('local');
    await signInAndStore(codex, req('work'), ctx(engine));
    expect(writeVolumeFileAtomic).toHaveBeenCalledWith(
      'agentbox-codex-config-acct-work',
      'agentbox/box:feedfacefeedface',
      expect.any(String),
      LOGIN,
    );
    expect(resetAccountVolume).toHaveBeenCalledTimes(1);

    await signInAndStore(codex, req('default'), ctx(fakeEngine('local').engine));
    expect(storeDefaultLogin).toHaveBeenCalledWith('codex', expect.any(String), LOGIN, {
      volume: true,
    });
  });
});
