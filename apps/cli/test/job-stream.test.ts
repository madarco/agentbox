import { describe, expect, it } from 'vitest';
import { streamJobToCompletion } from '../src/control-plane/job-stream.js';
import type { HubApiClient, HubApiJob } from '../src/control-plane/hub-api-client.js';

/**
 * A fake HubApiClient that returns a scripted sequence of job rows from getJob
 * and records submitLoginCode calls. streamJobLog is a no-op (the stream is
 * advisory; the verdict comes from the poll — the behavior under test).
 */
function fakeClient(jobs: HubApiJob[]): {
  client: HubApiClient;
  loginCodes: Array<{ id: string; code: string }>;
} {
  let i = 0;
  const loginCodes: Array<{ id: string; code: string }> = [];
  const client = {
    async streamJobLog() {
      /* advisory — no lines in this test */
    },
    async getJob() {
      const j = jobs[Math.min(i, jobs.length - 1)];
      i += 1;
      return j;
    },
    async submitLoginCode(id: string, code: string) {
      loginCodes.push({ id, code });
    },
  } as unknown as HubApiClient;
  return { client, loginCodes };
}

const FAST = { onLine: () => {}, pollMs: 1 } as const;

describe('streamJobToCompletion', () => {
  it('returns done with the job (boxId) on success', async () => {
    const { client } = fakeClient([
      { id: 'j', status: 'queued' },
      { id: 'j', status: 'running' },
      { id: 'j', status: 'done', boxId: 'box-1' },
    ]);
    const res = await streamJobToCompletion(client, 'j', FAST);
    expect(res.status).toBe('done');
    expect(res.job?.boxId).toBe('box-1');
  });

  it('surfaces a failed job as failed (never a silent done), carrying the error', async () => {
    const { client } = fakeClient([
      { id: 'j', status: 'running' },
      { id: 'j', status: 'failed', error: 'clone failed: auth' },
    ]);
    const res = await streamJobToCompletion(client, 'j', FAST);
    expect(res.status).toBe('failed');
    expect(res.detail).toBe('clone failed: auth');
  });

  it('drives the login-code affordance: prompts on awaiting-code and POSTs the code', async () => {
    const { client, loginCodes } = fakeClient([
      { id: 'j', status: 'running', login: { phase: 'awaiting-code', url: 'https://login' } },
      { id: 'j', status: 'done', boxId: 'box-2' },
    ]);
    const res = await streamJobToCompletion(client, 'j', {
      ...FAST,
      onLoginPrompt: async (url) => (url === 'https://login' ? 'CODE-1' : null),
    });
    expect(res.status).toBe('done');
    expect(loginCodes).toEqual([{ id: 'j', code: 'CODE-1' }]);
  });

  it('does not re-prompt for the same awaiting-code url', async () => {
    const { client, loginCodes } = fakeClient([
      { id: 'j', status: 'running', login: { phase: 'awaiting-code', url: 'https://login' } },
      { id: 'j', status: 'running', login: { phase: 'awaiting-code', url: 'https://login' } },
      { id: 'j', status: 'done', boxId: 'box-3' },
    ]);
    await streamJobToCompletion(client, 'j', {
      ...FAST,
      onLoginPrompt: async () => 'CODE-1',
    });
    expect(loginCodes).toHaveLength(1);
  });
});
