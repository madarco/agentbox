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

  it('healthz reports pid and AGENTBOX_CLI_ENTRY capability so ensureRelay can reclaim a crippled relay', async () => {
    const prev = process.env.AGENTBOX_CLI_ENTRY;
    try {
      delete process.env.AGENTBOX_CLI_ENTRY;
      const without = await fetchJson(handle, 'GET', '/healthz');
      expect(without.body).toMatchObject({ ok: true, pid: process.pid, cliEntry: false });

      process.env.AGENTBOX_CLI_ENTRY = '/some/cli/index.js';
      const withEntry = await fetchJson(handle, 'GET', '/healthz');
      expect(withEntry.body).toMatchObject({ cliEntry: true });
    } finally {
      if (prev === undefined) delete process.env.AGENTBOX_CLI_ENTRY;
      else process.env.AGENTBOX_CLI_ENTRY = prev;
    }
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

  it('/admin/stop-poller keeps the registration alive (unlike forget-box)', async () => {
    // A pause silences the poller but must NOT deregister the box: `list` and
    // the hub keep showing it, and the box token still works on wake.
    await register(handle, 'b', 't', 'name');
    const stop = await fetchJson(handle, 'POST', '/admin/stop-poller', { body: { boxId: 'b' } });
    expect(stop.status).toBe(204);

    const post = await fetchJson(handle, 'POST', '/events', { token: 't', body: { type: 'x' } });
    expect(post.status).toBe(202); // accepted — not the 401 forget-box would give
  });

  it('/admin/stop-poller rejects a missing boxId', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/stop-poller', { body: {} });
    expect(r.status).toBe(400);
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

  it('broadcasts box-status to subscribers, not just the durable file', async () => {
    // The attach footer's activity + `starting N/M…` service count come from
    // this snapshot. Persisting it is only enough when the footer runs on the
    // SAME machine as the relay — a box created by a control box reports THERE,
    // so the user's laptop has no status file and the stream is its only source.
    // Without this broadcast the footer renders a literal `unknown` forever.
    await register(handle, 'bcast-box', 'tk-bcast', 'bcast-box');

    const port = (handle.server.address() as AddressInfo).port;
    const ctrl = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${String(port)}/admin/prompts/stream?boxId=bcast-box`,
        { signal: ctrl.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const post = await fetchJson(handle, 'POST', '/events', {
        token: 'tk-bcast',
        body: {
          type: 'box-status',
          payload: {
            schema: 1,
            boxId: 'bcast-box',
            services: [{ name: 'web', state: 'starting' }],
            tasks: [],
          },
        },
      });
      expect(post.status).toBe(202);

      let buf = '';
      let sawStatus = false;
      for (let i = 0; i < 20 && !sawStatus; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        sawStatus = buf.includes('event: box-status');
      }
      expect(sawStatus).toBe(true);
      // The payload rides along, not just the event name — the footer parses it.
      expect(buf).toContain('"name":"web"');
    } finally {
      ctrl.abort();
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
    for (let i = 0; i < 500 && pendingId === null; i++) {
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

  it('git.push to a non-scratch SANCTIONED branch still prompts under the strict flag', async () => {
    // Regression: the docker gate must key "scratch bypass" on the branch it
    // actually pushes (sanctionedBranch), not the immutable create-time branch.
    // With autoApproveSafeHostActions:false and sanctionedBranch=main, the push
    // targets main and MUST prompt (not silently bypass).
    const reg = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: {
        boxId: 'b1',
        token: 't1',
        name: 'box-one',
        autoApproveSafeHostActions: false,
        worktrees: [
          {
            containerPath: '/workspace',
            hostMainRepo: '/tmp',
            branch: 'agentbox/box-one',
            sanctionedBranch: 'main',
          },
        ],
      },
    });
    expect(reg.status).toBe(204);
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    let pendingId: string | null = null;
    for (let i = 0; i < 500 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();
    await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    const rpc = await rpcPromise;
    expect(rpc.status).toBe(500);
    expect((rpc.body as { exitCode: number }).exitCode).toBe(10);
  });

  it('GET /admin/prompts lists pending host-action approvals with their context', async () => {
    await register(handle, 'b1', 't1', 'box-one');

    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });

    // Wait for the pending prompt to register.
    let pendingId: string | null = null;
    for (let i = 0; i < 500 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();

    const listed = await fetchJson(handle, 'GET', '/admin/prompts?boxId=b1');
    expect(listed.status).toBe(200);
    const body = listed.body as { prompts: Array<{ id: string; context?: { command?: string } }> };
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0]!.id).toBe(pendingId);
    expect(body.prompts[0]!.context?.command).toBe('git push');

    // Clean up the parked RPC.
    await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    await rpcPromise;
  });

  it('GET /admin/prompts requires a boxId query', async () => {
    const r = await fetchJson(handle, 'GET', '/admin/prompts');
    expect(r.status).toBe(400);
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
  let prevAuthedHost: string | undefined;
  let prevSshMap: string | undefined;
  let prevSshFail: string | undefined;

  beforeEach(async () => {
    const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    stubDir = await mkdtemp(join(tmpdir(), 'gh-stub-'));
    stubLog = join(stubDir, 'invocations.log');
    // Logs the env the relay handed us, not just argv: GH_HOST is the whole
    // point of the enterprise-host cases. STUB_AUTHED_HOST makes the stub "logged
    // into exactly one host" (unset = every host authed, `none` = nothing authed).
    const script = `#!/usr/bin/env bash
echo "GH_HOST=\${GH_HOST-}|$*" >> ${JSON.stringify(stubLog)}
case "$1" in
  --version) echo "gh stub 0.0.0"; exit 0 ;;
  auth)
    if [ "$2" = "status" ]; then
      case "\${STUB_AUTHED_HOST-}" in
        "") exit 0 ;;
        none) exit 1 ;;
        *)
          if [ "$3" = "--hostname" ] && [ "$4" != "\${STUB_AUTHED_HOST}" ]; then exit 1; fi
          exit 0 ;;
      esac
    fi ;;
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
    // `ssh -G` stub: the relay expands a remote's host through it so an
    // ~/.ssh/config alias never becomes a bogus GH_HOST. STUB_SSH_MAP is
    // `alias=real;alias=real`; anything unmapped resolves to itself.
    const sshScript = `#!/usr/bin/env bash
if [ -n "\${STUB_SSH_FAIL-}" ]; then exit 1; fi
dest="$2"
mapped="$dest"
IFS=';' read -ra entries <<< "\${STUB_SSH_MAP-}"
for e in "\${entries[@]}"; do
  if [ "\${e%%=*}" = "$dest" ]; then mapped="\${e#*=}"; fi
done
echo "hostname $mapped"
echo "user git"
exit 0
`;
    const sshPath = join(stubDir, 'ssh');
    await writeFile(sshPath, sshScript, 'utf8');
    await chmod(sshPath, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    prevPrompt = process.env.AGENTBOX_PROMPT;
    prevForce = process.env.AGENTBOX_GH_FORCE;
    prevCheckout = process.env.AGENTBOX_GH_PR_CHECKOUT;
    delete process.env.AGENTBOX_PROMPT;
    delete process.env.AGENTBOX_GH_FORCE;
    delete process.env.AGENTBOX_GH_PR_CHECKOUT;
    prevAuthedHost = process.env.STUB_AUTHED_HOST;
    prevSshMap = process.env.STUB_SSH_MAP;
    prevSshFail = process.env.STUB_SSH_FAIL;
    delete process.env.STUB_AUTHED_HOST;
    delete process.env.STUB_SSH_MAP;
    delete process.env.STUB_SSH_FAIL;
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
    if (prevAuthedHost === undefined) delete process.env.STUB_AUTHED_HOST;
    else process.env.STUB_AUTHED_HOST = prevAuthedHost;
    if (prevSshMap === undefined) delete process.env.STUB_SSH_MAP;
    else process.env.STUB_SSH_MAP = prevSshMap;
    if (prevSshFail === undefined) delete process.env.STUB_SSH_FAIL;
    else process.env.STUB_SSH_FAIL = prevSshFail;
    const gh = await import('../src/gh.js');
    gh._resetGhReadyCacheForTests();
  });

  async function registerWithWorktree(extra: Record<string, unknown> = {}): Promise<void> {
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
        ...extra,
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

  it('gh.pr.create auto-approves under the default safe flag (no prompt)', async () => {
    await registerWithWorktree();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--title', 'T', '--body', 'B'] },
      },
    });
    expect(r.status).toBe(200);
    expect(handle.prompts.size()).toBe(0);
  });

  it('gh.pr.create with an explicit --head still prompts (outside the safe subset)', async () => {
    // An explicit head can name any branch (e.g. main), so it is NOT auto —
    // it parks a confirm prompt even under the default safe flag.
    await registerWithWorktree();
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--head', 'main', '--title', 'T'] },
      },
    });
    let pendingId: string | null = null;
    for (let i = 0; i < 500 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();
    await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    const rpc = await rpcPromise;
    expect(rpc.status).toBe(500);
    expect((rpc.body as { exitCode: number }).exitCode).toBe(10);
  });

  it('gh.pr.create denial via /admin/prompts/answer returns exit 10 (strict flag)', async () => {
    // autoApproveSafeHostActions:false restores the always-prompt behavior.
    await registerWithWorktree({ autoApproveSafeHostActions: false });
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.pr.create',
        params: { path: '/workspace', args: ['--title', 'T', '--body', 'B'] },
      },
    });
    let pendingId: string | null = null;
    for (let i = 0; i < 500 && pendingId === null; i++) {
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

  /**
   * Which GitHub host the host's `gh` gets pointed at, derived from the box's
   * REGISTERED origin. github.com must keep behaving exactly as before (no
   * GH_HOST, no --hostname, no `ssh -G`); a GitHub Enterprise Server origin
   * must set GH_HOST and scope the auth probe; and an ~/.ssh/config alias must
   * be expanded rather than taken at face value.
   */
  async function readStubLog(): Promise<string[]> {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(stubLog, 'utf8').catch(() => '');
    return raw.split('\n').filter((l) => l.length > 0);
  }

  /** The `GH_HOST=…|argv` line for the gh invocation whose argv starts with `argv0`. */
  function lineFor(lines: string[], argv0: string): string {
    return lines.find((l) => l.split('|')[1]?.startsWith(argv0)) ?? '';
  }

  async function viewPr(): Promise<{ status: number; body: unknown }> {
    return fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'gh.pr.view', params: { path: '/workspace', args: ['123'] } },
    });
  }

  it('leaves gh on its default host for a github.com origin', async () => {
    await registerWithWorktree({ originUrl: 'git@github.com:o/r.git' });
    expect((await viewPr()).status).toBe(200);
    const lines = await readStubLog();
    expect(lineFor(lines, 'pr')).toMatch(/^GH_HOST=\|pr/);
    // Bare probe, exactly as before this knew about enterprise hosts.
    expect(lineFor(lines, 'auth')).toBe('GH_HOST=|auth status');
  });

  it('points gh at the enterprise host from an https origin', async () => {
    process.env.STUB_AUTHED_HOST = 'ghe.corp.example';
    await registerWithWorktree({ originUrl: 'https://ghe.corp.example/team/svc.git' });
    expect((await viewPr()).status).toBe(200);
    const lines = await readStubLog();
    expect(lineFor(lines, 'pr')).toMatch(/^GH_HOST=ghe\.corp\.example\|pr/);
    expect(lineFor(lines, 'auth')).toContain('auth status --hostname ghe.corp.example');
  });

  it('expands an ssh alias that resolves to github.com instead of inventing a host', async () => {
    process.env.STUB_SSH_MAP = 'github.com-work=github.com';
    process.env.STUB_AUTHED_HOST = 'github.com';
    await registerWithWorktree({ originUrl: 'git@github.com-work:o/r.git' });
    expect((await viewPr()).status).toBe(200);
    const lines = await readStubLog();
    // GH_HOST=github.com-work would have hard-failed gh ("none of the git
    // remotes correspond to the GH_HOST environment variable").
    expect(lineFor(lines, 'pr')).toMatch(/^GH_HOST=\|pr/);
    expect(lineFor(lines, 'auth')).toBe('GH_HOST=|auth status');
    // The alias is resolved, not probed: gh is never asked about a host that
    // only exists in ~/.ssh/config.
    expect(lines.some((l) => l.includes('github.com-work'))).toBe(false);
  });

  it('falls back to the default host when ssh cannot expand the remote', async () => {
    process.env.STUB_SSH_FAIL = '1';
    process.env.STUB_AUTHED_HOST = 'github.com';
    await registerWithWorktree({ originUrl: 'git@ghe.corp.example:team/svc.git' });
    expect((await viewPr()).status).toBe(200);
    const lines = await readStubLog();
    // Unverifiable host: prefer the behavior that worked before over a GH_HOST
    // that might be an alias gh itself knows how to resolve.
    expect(lineFor(lines, 'pr')).toMatch(/^GH_HOST=\|pr/);
    expect(lines.some((l) => l.includes('auth status --hostname ghe.corp.example'))).toBe(true);
    expect(lines.some((l) => l === 'GH_HOST=|auth status')).toBe(true);
  });

  it('expands an ssh alias that resolves to an enterprise host', async () => {
    process.env.STUB_SSH_MAP = 'ghe-work=ghe.corp.example';
    process.env.STUB_AUTHED_HOST = 'ghe.corp.example';
    await registerWithWorktree({ originUrl: 'git@ghe-work:team/svc.git' });
    expect((await viewPr()).status).toBe(200);
    const lines = await readStubLog();
    expect(lineFor(lines, 'pr')).toMatch(/^GH_HOST=ghe\.corp\.example\|pr/);
  });

  it('names the enterprise host when gh is not authenticated for it', async () => {
    process.env.STUB_AUTHED_HOST = 'github.com';
    await registerWithWorktree({ originUrl: 'https://ghe.corp.example/team/svc.git' });
    const r = await viewPr();
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(4);
    expect(body.stderr).toContain('ghe.corp.example');
    expect(body.stderr).toContain('gh auth login --hostname ghe.corp.example');
  });

  it('sets GH_HOST for gh.api without ever adding a --repo flag', async () => {
    process.env.STUB_AUTHED_HOST = 'ghe.corp.example';
    await registerWithWorktree({ originUrl: 'https://ghe.corp.example/team/svc.git' });
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'gh.api',
        params: { path: '/workspace', endpoint: 'repos/team/svc/pulls/1/comments' },
      },
    });
    expect(r.status).toBe(200);
    const apiLine = lineFor(await readStubLog(), 'api');
    expect(apiLine).toMatch(/^GH_HOST=ghe\.corp\.example\|api /);
    expect(apiLine).not.toMatch(/--repo|-R /);
  });

  it('probes gh once per host across a burst of calls', async () => {
    process.env.STUB_AUTHED_HOST = 'ghe.corp.example';
    await registerWithWorktree({ originUrl: 'https://ghe.corp.example/team/svc.git' });
    await viewPr();
    await viewPr();
    const lines = await readStubLog();
    expect(lines.filter((l) => l.includes('|auth status'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('|--version'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('|pr view'))).toHaveLength(2);
  });
});
