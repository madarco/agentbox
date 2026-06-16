import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ISLO_IMAGE_REF, isloBackend } from '../src/backend.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isloBackend', () => {
  const originalFetch = globalThis.fetch;
  let keyCounter = 0;

  beforeEach(() => {
    keyCounter += 1;
    process.env.AGENTBOX_ISLO_API_KEY = `test-key-${String(keyCounter)}`;
    process.env.AGENTBOX_ISLO_BASE_URL = 'https://compute.test.islo';
    process.env.AGENTBOX_ISLO_CONTROL_URL = 'https://control.test.islo';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AGENTBOX_ISLO_API_KEY;
    delete process.env.AGENTBOX_ISLO_BASE_URL;
    delete process.env.AGENTBOX_ISLO_CONTROL_URL;
    vi.restoreAllMocks();
  });

  function authResponse(url: string | URL | Request, init?: RequestInit): Response | null {
    if (String(url) !== 'https://control.test.islo/auth/token') return null;
    expect(init?.method).toBe('POST');
    return json({ session_token: `session-${String(keyCounter)}`, cookie_max_age: 600 });
  }

  it('provisions with the published AgentBox image for the local sentinel', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = authResponse(url, init);
      if (auth) return auth;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.image).toBe(DEFAULT_ISLO_IMAGE_REF);
      expect(body.vcpus).toBe(2);
      expect(body.memory_mb).toBe(4096);
      expect(body.disk_gb).toBe(10);
      expect(body.gateway_profile).toBe('prod');
      return json({
        id: 'sb_1',
        name: body.name,
        image: body.image,
        status: 'running',
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const h = await isloBackend.provision({
      name: 'My Box',
      image: 'agentbox/box:dev',
      resources: { cpu: 2, memory: 4, disk: 10 },
      networkPolicy: 'prod',
    });

    expect(h.sandboxId).toMatch(/^agentbox-my-box-/);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://compute.test.islo/sandboxes',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('executes a command by starting and polling an Islo exec', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = authResponse(url, init);
      if (auth) return auth;
      const path = String(url);
      if (path.endsWith('/sandboxes/sb/exec') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { command: string[]; user: string };
        expect(body.command).toEqual(['bash', '-lc', 'echo hi']);
        expect(body.user).toBe('vscode');
        return json({ exec_id: 'ex_1', status: 'running' });
      }
      if (path.endsWith('/sandboxes/sb/exec/ex_1')) {
        return json({
          exec_id: 'ex_1',
          status: 'completed',
          exit_code: 0,
          stdout: 'hi\n',
          stderr: '',
          truncated: false,
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(isloBackend.exec({ sandboxId: 'sb' }, 'echo hi')).resolves.toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
    });
  });

  it('reuses an existing share for preview URLs', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = authResponse(url, init);
      if (auth) return auth;
      expect(String(url)).toBe('https://compute.test.islo/sandboxes/sb/shares');
      return json([{ share_id: 'sh_1', port: 80, url: 'https://share.test' }]);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(isloBackend.previewUrl({ sandboxId: 'sb' }, 80)).resolves.toEqual({
      url: 'https://share.test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
