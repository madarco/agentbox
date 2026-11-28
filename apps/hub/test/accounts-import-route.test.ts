import { describe, expect, it, vi } from 'vitest';

// The route reaches the backend through this module (the real one pulls in the
// Next-only `@/lib/boxes/source`); a backend that records what it was handed.
const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../app/(dashboard)/api/v1/lib/backend', () => ({
  backendOrNull: () => ({
    importAccounts: (input: unknown) => {
      calls.push(input);
      return Promise.resolve({ ok: true, value: [] });
    },
  }),
}));
const { POST } = await import('../app/(dashboard)/api/v1/accounts/import/route');

const req = (items: unknown[], device?: string) =>
  new Request('http://hub/api/v1/accounts/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(device ? { 'x-agentbox-device-id': device } : {}),
    },
    body: JSON.stringify({ items }),
  });

describe('POST /api/v1/accounts/import pins a device to its own machine (#528 review)', () => {
  it('refuses a device token sending another machine', async () => {
    calls.length = 0;
    const res = await POST(req([{ machine: 'A' }, { machine: 'B' }], 'A'));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('takes a device sending its own machine, and the owner key for any machine', async () => {
    calls.length = 0;
    expect((await POST(req([{ machine: 'A' }], 'A'))).status).toBe(200);
    expect((await POST(req([{ machine: 'B' }]))).status).toBe(200);
    expect(calls.length).toBe(2);
  });
});
