import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import {
  parseIntegrationMethod,
  refuseIfIntegrationDisabled,
  refuseIntegrationCall,
  runHostIntegration,
} from '../src/integrations.js';
import type { IntegrationConnector } from '@agentbox/integrations';

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

describe('refuseIntegrationCall', () => {
  it('returns null when the op has no refuseCall hook', () => {
    expect(refuseIntegrationCall({ write: true }, ['anything'])).toBeNull();
  });

  it('lifts the descriptor refusal into a full GitRpcResult', () => {
    const op = {
      write: false,
      refuseCall: () => ({ exitCode: 65, stderr: 'no\n' }),
    };
    expect(refuseIntegrationCall(op, [])).toEqual({
      exitCode: 65,
      stdout: '',
      stderr: 'no\n',
    });
  });
});

describe('connector.env namespace guard', () => {
  // A future descriptor that tries to shadow a relay-controlled env var
  // (AGENTBOX_PROMPT, PATH, etc.) must be rejected so a careless contributor
  // can't disable the prompt gate from a descriptor. The runtime path
  // returns a typed exit-78 envelope (sysexits EX_CONFIG) instead of
  // throwing, so the in-box ctl prints the actual cause rather than an
  // opaque relay 'internal error' 500.
  it('returns exit 78 when a descriptor sets an env key outside its SERVICE_ namespace', async () => {
    const bogus: IntegrationConnector = {
      service: 'notion',
      hostBin: 'ntn',
      detect: { versionArgs: ['--version'] },
      env: { AGENTBOX_PROMPT: 'off' },
      ops: { ping: { write: false, buildArgv: () => ['--version'] } },
    };
    const r = await runHostIntegration(bogus, bogus.ops.ping!, [], process.cwd(), 5_000);
    expect(r.exitCode).toBe(78);
    expect(r.stderr).toMatch(/not in 'NOTION_\*' namespace/);
  });

  it('accepts an env key in the SERVICE_ namespace', async () => {
    const ok: IntegrationConnector = {
      service: 'notion',
      hostBin: '/bin/true',
      detect: { versionArgs: ['--version'] },
      env: { NOTION_KEYRING: '0' },
      ops: { ping: { write: false, buildArgv: () => [] } },
    };
    const r = await runHostIntegration(ok, ok.ops.ping!, [], process.cwd(), 5_000);
    expect(r.exitCode).toBe(0);
  });
});

describe('parseIntegrationMethod', () => {
  it('parses well-formed integration methods', () => {
    expect(parseIntegrationMethod('integration.notion.api')).toEqual({
      service: 'notion',
      op: 'api',
    });
    // Dotted op names (page.create) split on the FIRST two dots and keep
    // the rest as the op.
    expect(parseIntegrationMethod('integration.notion.page.create')).toEqual({
      service: 'notion',
      op: 'page.create',
    });
  });

  it('rejects degenerate shapes', () => {
    expect(parseIntegrationMethod('integration.notion.')).toBeNull();
    expect(parseIntegrationMethod('integration..api')).toBeNull();
    expect(parseIntegrationMethod('integration.notion.page..create')).toBeNull();
    expect(parseIntegrationMethod('integration.notion.api.')).toBeNull();
    expect(parseIntegrationMethod('integration.NOTION.api')).toBeNull();
    expect(parseIntegrationMethod('gh.pr.create')).toBeNull();
    expect(parseIntegrationMethod('')).toBeNull();
  });
});

/**
 * End-to-end relay /rpc dispatch through `handleIntegrationRpc`. We stub
 * `ntn` via a tempdir on PATH (same pattern as `relay /rpc gh.pr.* flow`
 * in server.test.ts) so the tests are deterministic on machines without
 * the real CLI. The stub records its argv + the value of NOTION_KEYRING
 * into side files so we can assert what was invoked.
 */
describe('relay /rpc integration.* flow', () => {
  let handle: RelayServerHandle;
  let stubDir: string;
  let stubLog: string;
  let stubEnvLog: string;
  let prevPath: string | undefined;
  let prevPrompt: string | undefined;

  beforeEach(async () => {
    stubDir = await mkdtemp(join(tmpdir(), 'ntn-stub-'));
    stubLog = join(stubDir, 'invocations.log');
    stubEnvLog = join(stubDir, 'env.log');
    // The stub records argv + the NOTION_KEYRING env value. `--version`
    // satisfies the readiness probe; `api …` and `pages create …` etc.
    // echo their argv and exit 0 so the relay's runHostIntegration
    // produces a stable, asserted stdout.
    const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(stubLog)}
echo "NOTION_KEYRING=\${NOTION_KEYRING-unset}" >> ${JSON.stringify(stubEnvLog)}
case "$1" in
  --version) echo "ntn stub 0.0.0"; exit 0 ;;
  *) echo "stub: ntn $*"; exit 0 ;;
esac
`;
    const stubPath = join(stubDir, 'ntn');
    await writeFile(stubPath, script, 'utf8');
    await chmod(stubPath, 0o755);
    // Workspace-layer agentbox.yaml that enables the Notion integration —
    // disabled by default, so without this every dispatch hits the relay's
    // host-side gate and returns exit 65. Lives in `stubDir` because that's
    // the `hostMainRepo` we register below; `loadEffectiveConfig` reads
    // <hostMainRepo>/agentbox.yaml's `defaults:` block as the workspace layer.
    await writeFile(
      join(stubDir, 'agentbox.yaml'),
      'defaults:\n  integrations:\n    notion:\n      enabled: true\n',
      'utf8',
    );
    prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    prevPrompt = process.env.AGENTBOX_PROMPT;
    delete process.env.AGENTBOX_PROMPT;
    const integ = await import('../src/integrations.js');
    integ._resetIntegrationReadyCacheForTests();
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    await rm(stubDir, { recursive: true, force: true });
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevPrompt === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPrompt;
    const integ = await import('../src/integrations.js');
    integ._resetIntegrationReadyCacheForTests();
  });

  async function registerBox(): Promise<void> {
    // hostMainRepo doesn't need to exist on disk: handleIntegrationRpc only
    // uses it as a cwd for the spawn, and the stub doesn't look at cwd.
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

  it('reads (api) bypass the prompt and propagate stub stdout', async () => {
    await registerBox();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.api',
        params: { path: '/workspace', args: ['v1/users/me'] },
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('stub: ntn api v1/users/me');
    expect(handle.prompts.size()).toBe(0);
    // NOTION_KEYRING=0 forced into the spawned env, so `ntn` reads
    // file-based auth on Linux boxes. Lines: --version probe + the call.
    const envSeen = await readFile(stubEnvLog, 'utf8');
    expect(envSeen).toMatch(/NOTION_KEYRING=0/);
    expect(envSeen).not.toMatch(/NOTION_KEYRING=unset/);
  });

  it('write op enqueues an askPrompt; denial returns exit 10', async () => {
    await registerBox();
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.page.create',
        params: { path: '/workspace', args: ['--parent', 'db_id', '--title', 'T'] },
      },
    });
    let pendingId: string | null = null;
    for (let i = 0; i < 50 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) {
        pendingId = list[0]!.id;
        // The wire-format prompt context surfaces the method to the wrapper.
        expect(list[0]!.context?.command).toBe('integration notion page.create');
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
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

  it('write op approved runs the host CLI', async () => {
    await registerBox();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.page.create',
        params: { path: '/workspace', args: ['--parent', 'db_id'] },
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('stub: ntn pages create --parent db_id');
  });

  it('op not on allowlist refuses with exit 65', async () => {
    await registerBox();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.bogus',
        params: { path: '/workspace', args: [] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(65);
    expect(body.stderr).toMatch(/not on allowlist/);
    // The stub must NOT have been invoked for a disallowed op.
    let invoked = false;
    try {
      const log = await readFile(stubLog, 'utf8');
      // Only `--version` from the readiness probe may appear.
      invoked = log.split('\n').some((l) => l.trim().length > 0 && l.trim() !== '--version');
    } catch {
      invoked = false;
    }
    expect(invoked).toBe(false);
  });

  it('unknown service surfaces exit 64 (allowlist-default; same envelope as cloud)', async () => {
    await registerBox();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.linear.api',
        params: { path: '/workspace', args: ['v1/issues'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/unknown integration service/);
  });

  it('malformed method shape surfaces exit 64', async () => {
    await registerBox();
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'integration.notion.' },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/unknown integration method shape/);
  });

  it('refuseCall blocks an `api -X DELETE` before the host CLI is touched', async () => {
    await registerBox();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.api',
        params: { path: '/workspace', args: ['-X', 'DELETE', 'v1/blocks/abc'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(65);
    expect(body.stderr).toMatch(/notion api/);
    // The stub must NOT have been spawned for the rejected api call.
    const log = await readFile(stubLog, 'utf8').catch(() => '');
    expect(log.split('\n').some((l) => l.trim() === '-X DELETE v1/blocks/abc')).toBe(false);
  });

  it('no worktree registered surfaces exit 64', async () => {
    // Register without worktrees so resolveWorktree returns null.
    const r0 = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: { boxId: 'b1', token: 't1', name: 'box-one' },
    });
    expect(r0.status).toBe(204);
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.api',
        params: { path: '/workspace', args: ['v1/users/me'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/no worktree registered/);
  });

  it('reports ntn-not-installed when the binary is missing from PATH', async () => {
    await registerBox();
    process.env.PATH = '/nonexistent-bin-dir';
    const integ = await import('../src/integrations.js');
    integ._resetIntegrationReadyCacheForTests();
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.api',
        params: { path: '/workspace', args: ['v1/users/me'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(127);
    expect(body.stderr).toMatch(/ntn not installed/);
  });

  it('disabled integration short-circuits with exit 65 and no host spawn', async () => {
    await registerBox();
    // Replace the workspace agentbox.yaml from beforeEach with one that
    // explicitly disables the integration. The relay re-reads the config
    // per call, so this takes effect immediately.
    await writeFile(
      join(stubDir, 'agentbox.yaml'),
      'defaults:\n  integrations:\n    notion:\n      enabled: false\n',
      'utf8',
    );
    process.env.AGENTBOX_PROMPT = 'off';
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: {
        method: 'integration.notion.api',
        params: { path: '/workspace', args: ['v1/users/me'] },
      },
    });
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(65);
    expect(body.stderr).toMatch(/notion integration is disabled/);
    expect(body.stderr).toMatch(/integrations\.notion\.enabled true/);
    // The host stub was never spawned for the disabled call. (The earlier
    // readiness probe DOES run via `assertIntegrationReady` once per
    // cache window — but the gate fires before that for *this* call;
    // verify by checking the api endpoint argv never lands in the log.)
    const log = await readFile(stubLog, 'utf8').catch(() => '');
    expect(log.split('\n').some((l) => l.trim() === 'api v1/users/me')).toBe(false);
  });
});

describe('refuseIfIntegrationDisabled', () => {
  // Pure unit test of the gate logic — uses the injected loader so it
  // doesn't depend on the filesystem. The relay /rpc tests above cover
  // the wiring; this one nails down the branches.
  const makeLoader = (
    integrations?: Record<string, { enabled?: boolean } | undefined>,
  ): (() => Promise<{
    effective: { integrations?: Record<string, { enabled?: boolean } | undefined> };
  }>) => () => Promise.resolve({ effective: { integrations } });

  it('returns null when the service is enabled', async () => {
    const out = await refuseIfIntegrationDisabled(
      'notion',
      '/tmp',
      makeLoader({ notion: { enabled: true } }),
    );
    expect(out).toBeNull();
  });

  it('returns the disabled refusal when the service slot is missing', async () => {
    const out = await refuseIfIntegrationDisabled('notion', '/tmp', makeLoader(undefined));
    expect(out?.exitCode).toBe(65);
    expect(out?.stderr).toMatch(/notion integration is disabled/);
  });

  it('returns the disabled refusal when the flag is false', async () => {
    const out = await refuseIfIntegrationDisabled(
      'notion',
      '/tmp',
      makeLoader({ notion: { enabled: false } }),
    );
    expect(out?.exitCode).toBe(65);
  });

  it('fails closed when the loader throws (malformed config → disabled)', async () => {
    const out = await refuseIfIntegrationDisabled('notion', '/tmp', () => {
      throw new Error('yaml parse error');
    });
    expect(out?.exitCode).toBe(65);
  });
});
