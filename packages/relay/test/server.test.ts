import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

interface FetchResult {
  status: number;
  body: unknown;
  text: string;
}

async function fetchJson(
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
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

async function register(
  handle: RelayServerHandle,
  boxId: string,
  token: string,
  name: string,
): Promise<void> {
  const r = await fetchJson(handle, 'POST', '/admin/register-box', {
    body: { boxId, token, name },
  });
  expect(r.status).toBe(204);
}

describe('relay server', () => {
  let handle: RelayServerHandle;
  let prevPromptEnv: string | undefined;

  beforeEach(async () => {
    // Auto-accept prompts in this suite — the existing /rpc git.push test
    // wants to exercise the worktree-resolution failure, which lives behind
    // the new askPrompt gate. Tests that actually want to test the prompt
    // flow are in the next describe block and clear this.
    prevPromptEnv = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    // port 0 = ephemeral; binding 127.0.0.1 to avoid firewall prompts on macOS.
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    if (prevPromptEnv === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPromptEnv;
  });

  it('healthz returns ok', async () => {
    const r = await fetchJson(handle, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });

  it('rejects /events without a bearer token', async () => {
    const r = await fetchJson(handle, 'POST', '/events', { body: { type: 'x' } });
    expect(r.status).toBe(401);
  });

  it('rejects /events with an unknown token', async () => {
    const r = await fetchJson(handle, 'POST', '/events', {
      token: 'nope',
      body: { type: 'x' },
    });
    expect(r.status).toBe(401);
  });

  it('accepts /events from a registered box and appends to the ring buffer', async () => {
    await register(handle, 'b1', 't1', 'box-one');
    const r = await fetchJson(handle, 'POST', '/events', {
      token: 't1',
      body: { type: 'service-state', payload: { service: 'web', state: 'crashed' } },
    });
    expect(r.status).toBe(202);
    expect(handle.events.size()).toBe(1);
    const all = handle.events.all();
    expect(all[0]).toMatchObject({
      boxId: 'b1',
      type: 'service-state',
      payload: { service: 'web', state: 'crashed' },
    });
  });

  it('/admin/events filters by box and since', async () => {
    await register(handle, 'a', 'ta', 'a-name');
    await register(handle, 'b', 'tb', 'b-name');
    await fetchJson(handle, 'POST', '/events', { token: 'ta', body: { type: '1' } });
    await fetchJson(handle, 'POST', '/events', { token: 'tb', body: { type: '2' } });
    await fetchJson(handle, 'POST', '/events', { token: 'ta', body: { type: '3' } });

    const r = await fetchJson(handle, 'GET', '/admin/events?box=a');
    expect(r.status).toBe(200);
    const events = (r.body as { events: Array<{ type: string }> }).events;
    expect(events.map((e) => e.type)).toEqual(['1', '3']);

    const r2 = await fetchJson(handle, 'GET', '/admin/events?since=2');
    const events2 = (r2.body as { events: Array<{ id: number }> }).events;
    expect(events2.map((e) => e.id)).toEqual([3]);
  });

  it('/admin/forget-box drops the registration so token stops working', async () => {
    await register(handle, 'b', 't', 'name');
    const forget = await fetchJson(handle, 'POST', '/admin/forget-box', { body: { boxId: 'b' } });
    expect(forget.status).toBe(204);

    const post = await fetchJson(handle, 'POST', '/events', { token: 't', body: { type: 'x' } });
    expect(post.status).toBe(401);
  });

  it('/rpc returns 501 for unknown methods', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't',
      body: { method: 'something.unhandled' },
    });
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ method: 'something.unhandled' });
  });

  it('/rpc git.push returns a structured error when no worktree is registered', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    // exitCode != 0 → 500 plus a {exitCode, stdout, stderr} envelope.
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/no worktree registered/);
  });

  it('/admin/registry returns boxes with tokens redacted', async () => {
    await register(handle, 'b', 'super-secret', 'one');
    const r = await fetchJson(handle, 'GET', '/admin/registry');
    expect(r.status).toBe(200);
    const body = r.body as { boxes: Array<Record<string, unknown>> };
    expect(body.boxes).toHaveLength(1);
    expect(body.boxes[0]).not.toHaveProperty('token');
    expect(body.boxes[0]).toMatchObject({ boxId: 'b', name: 'one' });
  });

  it('rejects malformed event bodies', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/events', { token: 't', body: { payload: 1 } });
    expect(r.status).toBe(400);
  });

  it('rejects /admin/register-box without required fields', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/register-box', { body: { boxId: 'b' } });
    expect(r.status).toBe(400);
  });

  it('persists registered projectIndex and uses it in /admin/registry', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: { boxId: 'idx-box', token: 'idx-tok', name: 'idx-name', projectIndex: 7 },
    });
    expect(r.status).toBe(204);
    const list = await fetchJson(handle, 'GET', '/admin/registry');
    expect(list.status).toBe(200);
    const body = list.body as { boxes: Array<{ boxId: string; projectIndex?: number }> };
    const entry = body.boxes.find((b) => b.boxId === 'idx-box');
    expect(entry?.projectIndex).toBe(7);
  });

  it('/admin/notices/set returns an id and /clear removes it', async () => {
    const set = await fetchJson(handle, 'POST', '/admin/notices/set', {
      body: { boxId: 'nb', kind: 'checkpoint', message: 'frozen' },
    });
    expect(set.status).toBe(200);
    const id = (set.body as { id: string }).id;
    expect(typeof id).toBe('string');
    expect(handle.notices.forBox('nb').map((n) => n.id)).toEqual([id]);

    const clear = await fetchJson(handle, 'POST', '/admin/notices/clear', {
      body: { boxId: 'nb', id },
    });
    expect(clear.status).toBe(204);
    expect(handle.notices.forBox('nb')).toHaveLength(0);
  });

  it('/admin/notices/set rejects a body missing message', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/notices/set', {
      body: { boxId: 'nb', kind: 'checkpoint' },
    });
    expect(r.status).toBe(400);
  });

  it('/admin/prompts/stream replays an active notice on connect', async () => {
    const set = await fetchJson(handle, 'POST', '/admin/notices/set', {
      body: { boxId: 'sse-box', kind: 'checkpoint', message: 'frozen' },
    });
    const id = (set.body as { id: string }).id;

    const port = (handle.server.address() as AddressInfo).port;
    const ctrl = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${String(port)}/admin/prompts/stream?boxId=sse-box`,
        { signal: ctrl.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawNotice = false;
      for (let i = 0; i < 20 && !sawNotice; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        if (buf.includes('event: notice-set') && buf.includes(id)) sawNotice = true;
      }
      expect(sawNotice).toBe(true);
    } finally {
      ctrl.abort();
    }
  });

  it('writes box-status into <id>-<n>-<mnemonic>/status.json when projectIndex is set', async () => {
    // Re-home $HOME so the status-store writes under a tmp dir and doesn't
    // pollute the user's ~/.agentbox during tests.
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'relay-status-'));
    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await fetchJson(handle, 'POST', '/admin/register-box', {
        body: { boxId: 'pid42', token: 'tk', name: 'My-Box', projectIndex: 42 },
      });
      const post = await fetchJson(handle, 'POST', '/events', {
        token: 'tk',
        body: {
          type: 'box-status',
          payload: { schema: 1, boxId: 'pid42', services: [], tasks: [] },
        },
      });
      expect(post.status).toBe(202);
      // `My-Box` sanitizes to `my_box`; segment is `<id>-<n>-<mnemonic>`.
      const target = join(home, '.agentbox', 'boxes', 'pid42-42-my_box', 'status.json');
      const text = await readFile(target, 'utf8');
      const json = JSON.parse(text) as { boxId: string };
      expect(json.boxId).toBe('pid42');
    } finally {
      process.env['HOME'] = originalHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

/**
 * The host-action prompt flow: a /rpc that touches host state (git.push,
 * cp.*, download.*) waits for a prompt-ask SSE event to be answered by a
 * subscribed host wrapper. The relay's `askPrompt` blocks indefinitely on
 * its Promise — these tests verify the answer + denial paths end-to-end
 * without leaving the test runner hung.
 */
describe('relay prompt flow', () => {
  let handle: RelayServerHandle;

  beforeEach(async () => {
    // Explicit: prompts ARE active (no AGENTBOX_PROMPT=off here).
    delete process.env.AGENTBOX_PROMPT;
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('denial via /admin/prompts/answer short-circuits git.push with exit 10', async () => {
    await register(handle, 'b1', 't1', 'box-one');

    // Kick off the /rpc — it'll hang waiting for an answer. We drive the
    // answer flow concurrently and await both.
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });

    // Wait for the pending prompt to land in the relay's map. The /rpc
    // handler adds it synchronously after authBox, but the await chain
    // means we need to yield. Polling the in-memory map is cheap.
    let pendingId: string | null = null;
    for (let i = 0; i < 50 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();

    const answer = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    expect(answer.status).toBe(204);

    const rpc = await rpcPromise;
    expect(rpc.status).toBe(500);
    const body = rpc.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(10);
    expect(body.stderr).toMatch(/denied by user/);
  });

  it('answer with unknown id returns 404', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: 'no-such-id', answer: 'y' },
    });
    expect(r.status).toBe(404);
  });

  it('answer with malformed body returns 400', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: 'x', answer: 'maybe' },
    });
    expect(r.status).toBe(400);
  });

  it('/admin/prompts/stream requires a boxId query', async () => {
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/prompts/stream`);
    expect(res.status).toBe(400);
  });
});

/**
 * `/rpc gh.pr.<op>` covers a fan of nine ops dispatched through a single
 * helper (handleGhPrRpc) that:
 *   - refuses unknown ops with 400,
 *   - applies env-only guards (merge bypass, checkout opt-in) before any
 *     fs/process work,
 *   - resolves the worktree,
 *   - probes for `gh` (assertGhReady),
 *   - askPrompts on write ops,
 *   - shells `gh pr <op>` in the host repo cwd.
 *
 * We stub `gh` via a tempdir on PATH so tests are deterministic on machines
 * without the real CLI; the stub records its argv into a side file so we can
 * assert what was invoked.
 */
describe('relay /rpc gh.pr.* flow', () => {
  let handle: RelayServerHandle;
  let stubDir: string;
  let stubLog: string;
  let prevPath: string | undefined;
  let prevPrompt: string | undefined;
  let prevForce: string | undefined;
  let prevCheckout: string | undefined;

  beforeEach(async () => {
    const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    stubDir = await mkdtemp(join(tmpdir(), 'gh-stub-'));
    stubLog = join(stubDir, 'invocations.log');
    const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(stubLog)}
case "$1" in
  --version) echo "gh stub 0.0.0"; exit 0 ;;
  auth)
    if [ "$2" = "status" ]; then exit 0; fi ;;
  pr)
    shift
    echo "stub: gh pr $*"
    exit 0
    ;;
esac
exit 0
`;
    const stubPath = join(stubDir, 'gh');
    await writeFile(stubPath, script, 'utf8');
    await chmod(stubPath, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    prevPrompt = process.env.AGENTBOX_PROMPT;
    prevForce = process.env.AGENTBOX_GH_FORCE;
    prevCheckout = process.env.AGENTBOX_GH_PR_CHECKOUT;
    delete process.env.AGENTBOX_PROMPT;
    delete process.env.AGENTBOX_GH_FORCE;
    delete process.env.AGENTBOX_GH_PR_CHECKOUT;
    const gh = await import('../src/gh.js');
    gh._resetGhReadyCacheForTests();
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    const { rm } = await import('node:fs/promises');
    await rm(stubDir, { recursive: true, force: true });
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevPrompt === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPrompt;
    if (prevForce === undefined) delete process.env.AGENTBOX_GH_FORCE;
    else process.env.AGENTBOX_GH_FORCE = prevForce;
    if (prevCheckout === undefined) delete process.env.AGENTBOX_GH_PR_CHECKOUT;
    else process.env.AGENTBOX_GH_PR_CHECKOUT = prevCheckout;
    const gh = await import('../src/gh.js');
    gh._resetGhReadyCacheForTests();
  });

  async function registerWithWorktree(): Promise<void> {
    // The worktree paths don't need to exist on disk: handleGhPrRpc only uses
    // hostMainRepo as a cwd for `gh`, and our stub ignores cwd.
    const r = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: {
        boxId: 'b1',
        token: 't1',
        name: 'box-one',
        worktrees: [
          { containerPath: '/workspace', hostMainRepo: stubDir, branch: 'agentbox/box-one' },
        ],
      },
    });
    expect(r.status).toBe(204);
  }

  it('rejects unknown gh.pr.* op with 400', async () => {
    await register(handle, 'b1', 't1', 'box-one');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.bogus' },
    });
    expect(r.status).toBe(400);
    const body = r.body as { error?: string };
    expect(body.error).toContain('unknown gh.pr.*');
  });

  it('gh.pr.checkout refused by default (env-gated)', async () => {
    await registerWithWorktree();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.checkout', params: { path: '/workspace', args: ['123'] } },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(13);
    expect(body.stderr).toMatch(/disabled by default/);
  });

  it('gh.pr.merge with AGENTBOX_PROMPT=off but no GH_FORCE refuses bypass', async () => {
    await registerWithWorktree();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.merge', params: { path: '/workspace', args: ['42', '--squash'] } },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(10);
    expect(body.stderr).toMatch(/AGENTBOX_GH_FORCE=1/);
  });

  it('gh.pr.view (read-only) runs gh without an askPrompt entry', async () => {
    await registerWithWorktree();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.view', params: { path: '/workspace', args: ['7'] } },
    });
    expect(r.status).toBe(200);
    const body = r.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('stub: gh pr view 7');
    expect(handle.prompts.size()).toBe(0);
  });

  it('gh.pr.create denial via /admin/prompts/answer returns exit 10', async () => {
    await registerWithWorktree();
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--title', 'T', '--body', 'B'] },
      },
    });
    let pendingId: string | null = null;
    for (let i = 0; i < 50 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();

    const answer = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    expect(answer.status).toBe(204);

    const rpc = await rpcPromise;
    expect(rpc.status).toBe(500);
    const body = rpc.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(10);
    expect(body.stderr).toMatch(/denied by user/);
  });

  it('gh.pr.create with AGENTBOX_PROMPT=off runs gh and injects --head <box branch>', async () => {
    await registerWithWorktree();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--title', 'T', '--body', 'B', '--draft'] },
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    // The relay defaults --head to the registered box branch so gh doesn't have
    // to infer it from the host repo's (different) checked-out branch.
    expect(body.stdout).toContain(
      'stub: gh pr create --head agentbox/box-one --title T --body B --draft',
    );
  });

  it('gh.pr.create refuses (exit 65) when the box branch cannot be resolved', async () => {
    // Register a worktree with an empty branch so injectPrCreateHead can't add
    // --head; the relay must refuse rather than let gh fall back to the host
    // repo's checked-out branch.
    const r0 = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: {
        boxId: 'b1',
        token: 't1',
        name: 'box-one',
        worktrees: [{ containerPath: '/workspace', hostMainRepo: stubDir, branch: '' }],
      },
    });
    expect(r0.status).toBe(204);
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--title', 'T'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string; stdout: string };
    expect(body.exitCode).toBe(65);
    expect(body.stderr).toMatch(/refusing to run without --head/);
    // gh must not have been invoked.
    expect(body.stdout).not.toContain('stub: gh pr create');
  });

  it('gh.pr.create does not double-inject --head when the caller passed one', async () => {
    await registerWithWorktree();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--head', 'feature/x', '--title', 'T'] },
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('stub: gh pr create --head feature/x --title T');
    expect(body.stdout).not.toContain('agentbox/box-one');
  });

  it('gh.pr.view returns 500 with exit 64 when no worktree is registered', async () => {
    await register(handle, 'b1', 't1', 'box-one');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.view', params: { path: '/workspace' } },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/no worktree registered/);
  });

  it('reports gh-not-installed when gh is missing from PATH', async () => {
    await registerWithWorktree();
    // Drop the stub from PATH; assertGhReady should now find no gh.
    process.env.PATH = '/nonexistent-bin-dir';
    const gh = await import('../src/gh.js');
    gh._resetGhReadyCacheForTests();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.view', params: { path: '/workspace' } },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(127);
    expect(body.stderr).toMatch(/gh not installed/);
  });
});
