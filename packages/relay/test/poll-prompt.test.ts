import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

/**
 * Poll-mode approvals (the hosted control plane). A gated /rpc returns
 * `202 {promptId}` instead of blocking; the human answers via
 * /admin/prompts/answer (now backed by the store mailbox); the box polls
 * /rpc/status/:id for the verdict + result. Drives the flow over real HTTP.
 */
interface FetchResult {
  status: number;
  body: unknown;
}

async function call(
  handle: RelayServerHandle,
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<FetchResult> {
  const port = (handle.server.address() as AddressInfo).port;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

describe('poll-mode prompts', () => {
  let handle: RelayServerHandle;
  let prevPrompt: string | undefined;

  beforeEach(async () => {
    prevPrompt = process.env.AGENTBOX_PROMPT;
    delete process.env.AGENTBOX_PROMPT; // prompts active
    handle = await startRelayServer({ port: 0, host: '127.0.0.1', promptMode: 'poll' });
    // A docker-kind box with no worktree: git.push needs approval (non-agentbox
    // branch), and the approved action resolves deterministically to exit 64
    // ("no worktree") — enough to prove the execute-on-approval ran.
    const r = await call(handle, 'POST', '/admin/register-box', {
      body: { boxId: 'b1', token: 't1', name: 'box-one' },
    });
    expect(r.status).toBe(204);
  });

  afterEach(async () => {
    await handle.close();
    if (prevPrompt === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPrompt;
  });

  it('git.push parks with 202 + promptId, lists pending, then runs on approval', async () => {
    const rpc = await call(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    expect(rpc.status).toBe(202);
    const promptId = (rpc.body as { status: string; promptId: string }).promptId;
    expect((rpc.body as { status: string }).status).toBe('pending');
    expect(typeof promptId).toBe('string');

    // Pending shows up in the admin mailbox listing with its context.
    const listed = await call(handle, 'GET', '/admin/prompts?boxId=b1');
    const prompts = (listed.body as { prompts: Array<{ id: string; context?: { command?: string } }> })
      .prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.id).toBe(promptId);
    expect(prompts[0]!.context?.command).toBe('git push');

    // Box polls before the answer → still pending.
    const before = await call(handle, 'GET', `/rpc/status/${promptId}`, { token: 't1' });
    expect(before.body).toEqual({ status: 'pending' });

    // Human approves.
    const ans = await call(handle, 'POST', '/admin/prompts/answer', {
      body: { id: promptId, answer: 'y' },
    });
    expect(ans.status).toBe(204);

    // Next poll runs the action and returns its result (exit 64: no worktree).
    const done = await call(handle, 'GET', `/rpc/status/${promptId}`, { token: 't1' });
    const body = done.body as { status: string; result: { exitCode: number } };
    expect(body.status).toBe('done');
    expect(body.result.exitCode).toBe(64);

    // Re-poll is idempotent (cached result, same exit code).
    const again = await call(handle, 'GET', `/rpc/status/${promptId}`, { token: 't1' });
    expect((again.body as { result: { exitCode: number } }).result.exitCode).toBe(64);
  });

  it('denial returns exit 10 on the next poll', async () => {
    const rpc = await call(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    expect(rpc.status).toBe(202);
    const promptId = (rpc.body as { promptId: string }).promptId;

    await call(handle, 'POST', '/admin/prompts/answer', { body: { id: promptId, answer: 'n' } });

    const done = await call(handle, 'GET', `/rpc/status/${promptId}`, { token: 't1' });
    const body = done.body as { status: string; result: { exitCode: number; stderr: string } };
    expect(body.status).toBe('done');
    expect(body.result.exitCode).toBe(10);
    expect(body.result.stderr).toMatch(/denied by user/);
  });

  it('agentbox/* branch pushes bypass approval (no parking)', async () => {
    // Register a worktree on an agentbox/* branch → push is auto-allowed.
    await call(handle, 'POST', '/admin/register-box', {
      body: {
        boxId: 'b2',
        token: 't2',
        name: 'box-two',
        worktrees: [{ containerPath: '/workspace', hostMainRepo: '/tmp/none', branch: 'agentbox/box-two' }],
      },
    });
    const rpc = await call(handle, 'POST', '/rpc', {
      token: 't2',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    // Executes immediately (not 202). No worktree dir on disk → git fails, but
    // the point is it ran inline without an approval round-trip.
    expect(rpc.status).not.toBe(202);
  });

  it('/rpc/status for an unknown promptId is 404', async () => {
    const r = await call(handle, 'GET', '/rpc/status/nope', { token: 't1' });
    expect(r.status).toBe(404);
  });

  it('/rpc/status requires a valid box token', async () => {
    const r = await call(handle, 'GET', '/rpc/status/whatever', { token: 'bad' });
    expect(r.status).toBe(401);
  });
});
