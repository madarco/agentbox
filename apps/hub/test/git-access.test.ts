import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_KEY_MISSING,
  apiHostOf,
  appInfoViaApi,
  createGitAccessBackend,
  ghUserViaCli,
  isRejectedTokenError,
  resolveGitAccessMode,
  type GitAccessDeps,
} from '../lib/backend/git-access';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const APP = { appId: '42', privateKeyPem: 'unused-in-these-tests' };

function deps(over: Partial<GitAccessDeps> = {}): Partial<GitAccessDeps> {
  return {
    isControlBox: () => false,
    configuredMode: () => Promise.resolve(undefined),
    token: () => undefined,
    appConfig: () => null,
    ghHost: () => 'github.com',
    apiHost: () => 'github.com',
    ghUser: () => Promise.resolve({ ok: true, login: 'octo' }),
    appInfo: () => Promise.reject(new Error('no app in this test')),
    now: () => 0,
    ...over,
  };
}

describe('resolveGitAccessMode', () => {
  it('is local whenever the hub is not a control box', () => {
    expect(resolveGitAccessMode({ controlBox: false, configured: 'app' })).toBe('local');
  });
  it('follows hub.gitAuth exactly, defaulting to gh like bootstrap-launch does', () => {
    expect(resolveGitAccessMode({ controlBox: true, configured: 'app' })).toBe('app');
    expect(resolveGitAccessMode({ controlBox: true, configured: 'gh' })).toBe('gh');
    expect(resolveGitAccessMode({ controlBox: true, configured: undefined })).toBe('gh');
  });
});

describe('apiHostOf', () => {
  it('names the host the App API calls go to', () => {
    expect(apiHostOf(undefined)).toBe('github.com');
    expect(apiHostOf('https://api.github.com')).toBe('github.com');
    expect(apiHostOf('https://ghe.corp/api/v3')).toBe('ghe.corp');
    expect(apiHostOf('not a url')).toBe('github.com');
  });
});

describe('createGitAccessBackend', () => {
  it('local: reports the PC gh login and never reads the hub token', async () => {
    const token = vi.fn(() => TOKEN);
    const ghUser = vi.fn(() => Promise.resolve({ ok: true as const, login: 'ada' }));
    const b = createGitAccessBackend(deps({ token, ghUser }));
    expect(await b.getGitAccess()).toEqual({ mode: 'local', host: 'github.com', login: 'ada' });
    expect(token).not.toHaveBeenCalled();
    expect(ghUser).toHaveBeenCalledWith(undefined);
  });

  it('local: no gh login is a plain local view, not an error', async () => {
    const b = createGitAccessBackend(
      deps({
        ghUser: () => Promise.resolve({ ok: false, rejected: false, error: 'not logged in' }),
      }),
    );
    expect(await b.getGitAccess()).toEqual({ mode: 'local', host: 'github.com' });
  });

  it('local: a throwing lookup still answers', async () => {
    const b = createGitAccessBackend(deps({ ghUser: () => Promise.reject(new Error('boom')) }));
    expect(await b.getGitAccess()).toEqual({ mode: 'local', host: 'github.com' });
  });

  it('gh: resolves the login with the hub token and never returns the token', async () => {
    const ghUser = vi.fn(() => Promise.resolve({ ok: true as const, login: 'hub-bot' }));
    const b = createGitAccessBackend(
      deps({ isControlBox: () => true, token: () => TOKEN, ghUser }),
    );
    const v = await b.getGitAccess();
    expect(v).toEqual({ mode: 'gh', host: 'github.com', tokenPresent: true, login: 'hub-bot' });
    expect(ghUser).toHaveBeenCalledWith(TOKEN);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it('gh: a 401 is reported as a rejected token', async () => {
    const b = createGitAccessBackend(
      deps({
        isControlBox: () => true,
        token: () => TOKEN,
        ghUser: () =>
          Promise.resolve({ ok: false, rejected: true, error: 'HTTP 401: Bad credentials' }),
      }),
    );
    expect(await b.getGitAccess()).toEqual({
      mode: 'gh',
      host: 'github.com',
      tokenPresent: true,
      tokenRejected: true,
      error: 'HTTP 401: Bad credentials',
    });
  });

  it('gh: no token says so without calling gh', async () => {
    const ghUser = vi.fn();
    const b = createGitAccessBackend(deps({ isControlBox: () => true, ghUser }));
    expect(await b.getGitAccess()).toEqual({ mode: 'gh', host: 'github.com', tokenPresent: false });
    expect(ghUser).not.toHaveBeenCalled();
  });

  it('caches a good answer for minutes and a failure for one minute', async () => {
    let now = 0;
    const ghUser = vi.fn(() => Promise.resolve({ ok: true as const, login: 'hub-bot' }));
    const b = createGitAccessBackend(
      deps({ isControlBox: () => true, token: () => TOKEN, ghUser, now: () => now }),
    );
    await b.getGitAccess();
    now = 4 * 60_000;
    await b.getGitAccess();
    expect(ghUser).toHaveBeenCalledTimes(1);
    now = 6 * 60_000;
    await b.getGitAccess();
    expect(ghUser).toHaveBeenCalledTimes(2);

    const failing = vi.fn(() =>
      Promise.resolve({ ok: false as const, rejected: false, error: 'offline' }),
    );
    let t = 0;
    const f = createGitAccessBackend(
      deps({ isControlBox: () => true, token: () => TOKEN, ghUser: failing, now: () => t }),
    );
    await f.getGitAccess();
    t = 61_000;
    await f.getGitAccess();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('app: carries the App identity and installations', async () => {
    const app = {
      id: '42',
      name: 'agentbox-acme',
      slug: 'agentbox-acme',
      installations: [{ account: 'acme', repositories: 'selected' as const }],
    };
    const b = createGitAccessBackend(
      deps({
        isControlBox: () => true,
        configuredMode: () => Promise.resolve('app'),
        appConfig: () => APP,
        appInfo: () => Promise.resolve(app),
      }),
    );
    expect(await b.getGitAccess()).toEqual({ mode: 'app', host: 'github.com', app });
  });

  it('app: a failed GitHub read keeps the App id and says why', async () => {
    const b = createGitAccessBackend(
      deps({
        isControlBox: () => true,
        configuredMode: () => Promise.resolve('app'),
        appConfig: () => APP,
        appInfo: () => Promise.reject(new Error('GET /app → 401')),
      }),
    );
    expect(await b.getGitAccess()).toEqual({
      mode: 'app',
      host: 'github.com',
      app: { id: '42' },
      error: 'GET /app → 401',
    });
  });
});

describe('createGitAccessBackend: App beside a token', () => {
  it('app mode with no App key says the key is missing', async () => {
    const b = createGitAccessBackend(
      deps({ isControlBox: () => true, configuredMode: () => Promise.resolve('app') }),
    );
    expect(await b.getGitAccess()).toEqual({
      mode: 'app',
      host: 'github.com',
      error: APP_KEY_MISSING,
    });
  });

  it('an App on a gh hub stays gh, and names the App the worker clones through', async () => {
    const appInfo = vi.fn();
    const b = createGitAccessBackend(
      deps({ isControlBox: () => true, token: () => TOKEN, appConfig: () => APP, appInfo }),
    );
    expect(await b.getGitAccess()).toEqual({
      mode: 'gh',
      host: 'github.com',
      tokenPresent: true,
      login: 'octo',
      app: { id: '42' },
    });
    expect(appInfo).not.toHaveBeenCalled();
  });

  it('concurrent misses share one lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ghUser = vi.fn(async () => {
      await gate;
      return { ok: true as const, login: 'hub-bot' };
    });
    const b = createGitAccessBackend(
      deps({ isControlBox: () => true, token: () => TOKEN, ghUser }),
    );
    const both = Promise.all([b.getGitAccess(), b.getGitAccess()]);
    release();
    await both;
    expect(ghUser).toHaveBeenCalledTimes(1);
  });

  it('reads hub.gitAuth once', async () => {
    const configuredMode = vi.fn(() => Promise.resolve('gh' as const));
    const b = createGitAccessBackend(deps({ isControlBox: () => true, configuredMode }));
    await b.getGitAccess();
    await b.getGitAccess();
    expect(configuredMode).toHaveBeenCalledTimes(1);
  });
});

describe('ghUserViaCli', () => {
  it('passes the hub token as GH_TOKEN and drops GITHUB_TOKEN', async () => {
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ambient';
    try {
      const run = vi.fn<(args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>>(
        () => Promise.resolve({ stdout: 'hub-bot\n' }),
      );
      expect(await ghUserViaCli(run)(TOKEN)).toEqual({ ok: true, login: 'hub-bot' });
      const [args, env] = run.mock.calls[0]!;
      expect(args).toEqual(['api', 'user', '--jq', '.login']);
      expect(env.GH_TOKEN).toBe(TOKEN);
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  it('maps a 401 to rejected and masks a token in the message', async () => {
    const run = () =>
      Promise.reject(
        Object.assign(new Error('Command failed'), {
          stderr: `HTTP 401: Bad credentials (token ${TOKEN})`,
        }),
      );
    const r = await ghUserViaCli(run)(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejected).toBe(true);
      expect(r.error).not.toContain(TOKEN);
    }
  });

  it('reports a missing gh binary plainly', async () => {
    const run = () =>
      Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(await ghUserViaCli(run)(undefined)).toEqual({
      ok: false,
      rejected: false,
      error: 'gh is not installed',
    });
  });

  it('isRejectedTokenError', () => {
    expect(isRejectedTokenError('gh: Bad credentials (HTTP 401)')).toBe(true);
    expect(isRejectedTokenError('HTTP 403: rate limited')).toBe(false);
  });
});

describe('appInfoViaApi', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = {
    appId: '42',
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };

  it('reads the App and its installations with the App JWT', async () => {
    const fetchImpl = vi.fn((url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      if (url.endsWith('/app')) {
        return Promise.resolve(
          Response.json({
            name: 'agentbox-acme',
            slug: 'agentbox-acme',
            html_url: 'https://github.com/apps/agentbox-acme',
            owner: { login: 'acme' },
          }),
        );
      }
      return Promise.resolve(
        Response.json([
          { account: { login: 'acme' }, repository_selection: 'all' },
          { account: { login: 'ada' }, repository_selection: 'selected' },
        ]),
      );
    });
    expect(await appInfoViaApi(fetchImpl)(cfg)).toEqual({
      id: '42',
      name: 'agentbox-acme',
      slug: 'agentbox-acme',
      url: 'https://github.com/apps/agentbox-acme',
      owner: 'acme',
      installations: [
        { account: 'acme', repositories: 'all' },
        { account: 'ada', repositories: 'selected' },
      ],
    });
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://api.github.com/app/installations?per_page=100&page=1',
    );
  });

  it('keeps the identity when the installations body is not a list', async () => {
    const fetchImpl = (url: string) =>
      Promise.resolve(
        url.endsWith('/app')
          ? Response.json({ name: 'agentbox-acme' })
          : Response.json({ message: 'proxy error' }),
      );
    expect(await appInfoViaApi(fetchImpl)(cfg)).toEqual({ id: '42', name: 'agentbox-acme' });
  });

  it('throws when GitHub refuses the App', async () => {
    const fetchImpl = () => Promise.resolve(new Response('', { status: 401 }));
    await expect(appInfoViaApi(fetchImpl)(cfg)).rejects.toThrow('GET /app → 401');
  });
});
