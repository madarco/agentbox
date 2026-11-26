import { describe, expect, it, vi } from 'vitest';

/**
 * A store that cannot be read (a corrupt accounts.json) must come back as the
 * API's error envelope naming the file — the CLI shows that message — never a
 * bare 500 the client can only call "unexpected non-JSON response".
 */
const MESSAGE = '/home/u/.agentbox/accounts.json: not valid JSON. Refusing to rewrite it';
const { throwing } = vi.hoisted(() => ({
  throwing: () =>
    Promise.reject(
      new Error('/home/u/.agentbox/accounts.json: not valid JSON. Refusing to rewrite it'),
    ),
}));
// The routes reach the backend through this module (the real one pulls in the
// Next-only `@/lib/boxes/source`); a backend whose store cannot be read.
vi.mock('../app/(dashboard)/api/v1/lib/backend', () => ({
  backendOrNull: () => ({
    addPastedAccount: throwing,
    removeAccount: throwing,
  }),
}));
const { POST } = await import('../app/(dashboard)/api/v1/accounts/route');
const { DELETE } = await import('../app/(dashboard)/api/v1/accounts/[agent]/[id]/route');

const ctx = { params: Promise.resolve({ agent: 'claude', id: 'work' }) };
const json = (body: unknown) =>
  new Request('http://hub/api/v1/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function expectEnvelope(res: Response): Promise<void> {
  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error).toEqual({ code: 'internal', message: MESSAGE });
}

describe('accounts routes answer a store failure with the error envelope (#444 review)', () => {
  it('POST', async () => {
    await expectEnvelope(
      await POST(json({ agent: 'claude', id: 'ci', kind: 'api-key', token: 'x' })),
    );
  });
  it('DELETE', async () => {
    await expectEnvelope(await DELETE(new Request('http://hub/x', { method: 'DELETE' }), ctx));
  });
});
