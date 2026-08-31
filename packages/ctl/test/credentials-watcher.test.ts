import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SYNC_SPECS, isRealAgentCredential } from '@agentbox/sandbox-core';
import type { PostOutcome, RelayClient } from '../src/relay-client.js';
import {
  CredentialsWatcher,
  isRealCredentialText,
  isRetryablePostFailure,
  WATCHED_CREDENTIALS,
} from '../src/credentials-watcher.js';
import { CREDENTIALS_UPDATED_EVENT } from '../src/types.js';

const CLAUDE_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 123 },
});

const DELIVERED: PostOutcome = { ok: true, status: 202 };

/** `outcomes` is consumed one per call; once exhausted every post is delivered. */
function fakeRelay(outcomes: PostOutcome[] = []): {
  relay: RelayClient;
  post: ReturnType<typeof vi.fn>;
} {
  const queue = [...outcomes];
  const post = vi.fn(() => Promise.resolve(queue.shift() ?? DELIVERED));
  return { relay: { enabled: true, post } as unknown as RelayClient, post };
}

/**
 * ctl's baked lists cover the agents that were IN the image when it was baked —
 * not every agent the host's registry knows about.
 *
 * That distinction is the whole point of the `agents.list` RPC (#340): ctl ships
 * inside the box, so an agent added after the bake can never appear in a
 * compiled-in list, and demanding one here would re-impose exactly the coupling
 * that RPC exists to break. A hidden agent is precisely that case — it is not
 * baked into any image — so it is excluded here and covered by
 * `agent-registry-fetch.test.ts`, which asserts the host-supplied list reaches
 * the daemon.
 */
const BAKED_SPECS = AGENT_SYNC_SPECS.filter((s) => !s.hidden);

describe('WATCHED_CREDENTIALS drift vs @agentbox/sandbox-core registry', () => {
  it('mirrors credential.boxAbsPath and realShape per baked agent', () => {
    for (const spec of BAKED_SPECS) {
      const watched = WATCHED_CREDENTIALS.find((w) => w.agent === spec.id);
      expect(watched, `missing watcher entry for '${spec.id}'`).toBeDefined();
      expect(watched!.path).toBe(spec.credential.boxAbsPath);
      expect(watched!.shape).toBe(spec.credential.realShape);
    }
    expect(WATCHED_CREDENTIALS).toHaveLength(BAKED_SPECS.length);
  });

  it('isRealCredentialText agrees with isRealAgentCredential', () => {
    const samples = [
      CLAUDE_BLOB,
      JSON.stringify({ claudeAiOauth: { refreshToken: '' } }),
      JSON.stringify({ some: 'auth' }),
      JSON.stringify({}),
      'not-json',
      JSON.stringify([1, 2]),
    ];
    for (const spec of BAKED_SPECS) {
      const watched = WATCHED_CREDENTIALS.find((w) => w.agent === spec.id)!;
      for (const sample of samples) {
        expect(
          isRealCredentialText(watched.shape, sample),
          `agent=${spec.id} sample=${sample.slice(0, 40)}`,
        ).toBe(isRealAgentCredential(spec.id, sample));
      }
    }
  });
});

describe('CredentialsWatcher', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cred-watcher-'));
    path = join(dir, '.credentials.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function watcher(relay: RelayClient): CredentialsWatcher {
    return new CredentialsWatcher({
      relay,
      files: [{ agent: 'claude', path, shape: 'claude-oauth' }],
    });
  }

  it('posts the blob on first sight and not again while unchanged', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay();
    const w = watcher(relay);
    await w.scan();
    expect(post).toHaveBeenCalledTimes(1);
    const [type, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe(CREDENTIALS_UPDATED_EVENT);
    expect(payload['agent']).toBe('claude');
    expect(Buffer.from(payload['contentBase64'] as string, 'base64').toString('utf8')).toBe(
      CLAUDE_BLOB,
    );
    await w.scan();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reposts when the file content changes', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay();
    const w = watcher(relay);
    await w.scan();
    const rotated = JSON.stringify({
      claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 456 },
    });
    await writeFile(path, rotated);
    // Force a distinct mtime — sub-ms writes can share a timestamp.
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);
    await w.scan();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never posts invalid or missing credential files', async () => {
    const { relay, post } = fakeRelay();
    const w = watcher(relay);
    await w.scan(); // missing file
    await writeFile(path, JSON.stringify({ claudeAiOauth: { refreshToken: '' } }));
    await w.scan(); // placeholder blob
    expect(post).not.toHaveBeenCalled();
  });

  it('does nothing when the relay is disabled', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const post = vi.fn();
    const relay = { enabled: false, post } as unknown as RelayClient;
    await watcher(relay).scan();
    expect(post).not.toHaveBeenCalled();
  });

  // The bug this guards: bookkeeping used to be committed before the
  // fire-and-forget post was even attempted, so an update lost to a relay
  // restart was lost forever — and since a Claude refresh rotates the token,
  // that silently killed every other copy of the login.
  it('retries on the next scan when the post never reached the relay', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay([{ ok: false, status: null }]);
    const w = watcher(relay);
    await w.scan();
    expect(post).toHaveBeenCalledTimes(1);
    await w.scan();
    expect(post).toHaveBeenCalledTimes(2);
    // Delivered on the retry — now it stops.
    await w.scan();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx and stops once delivered', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay([{ ok: false, status: 503 }]);
    const w = watcher(relay);
    await w.scan();
    await w.scan();
    await w.scan();
    expect(post).toHaveBeenCalledTimes(2);
  });

  // A 202 with `accepted: false` (the relay judged the blob stale) is delivery,
  // not failure — resending it every 15s forever would be pure noise.
  it('treats any 2xx as delivered', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay([{ ok: true, status: 202 }]);
    const w = watcher(relay);
    await w.scan();
    await w.scan();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx — that payload will never be accepted', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay([{ ok: false, status: 400 }]);
    const w = watcher(relay);
    await w.scan();
    await w.scan();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('flush() makes one final attempt, for shutdown', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay();
    await watcher(relay).flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('passes a longer timeout than the relay default', async () => {
    await writeFile(path, CLAUDE_BLOB);
    const { relay, post } = fakeRelay();
    await watcher(relay).scan();
    const [, , opts] = post.mock.calls[0] as [string, unknown, { timeoutMs?: number }];
    expect(opts.timeoutMs).toBeGreaterThan(2000);
  });
  describe('setFiles', () => {
    // The daemon starts this watcher on the BAKED list so credential fan-out is
    // never off, then upgrades it once the host answers `agents.list`. Awaiting
    // that answer first is what let a cloud box with no host poller lose fan-out
    // outright (PR #340 review).
    it('picks up an agent that was not in the starting list', async () => {
      const extra = join(dir, 'auth.json');
      await writeFile(extra, JSON.stringify({ some: 'auth' }));
      const { relay, post } = fakeRelay();
      const w = watcher(relay);
      await w.scan();
      expect(post).not.toHaveBeenCalled();

      w.setFiles([{ agent: 'codex', path: extra, shape: 'nonempty-json' }]);
      await w.scan();
      expect(post).toHaveBeenCalledTimes(1);
      const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload['agent']).toBe('codex');
    });

    // `lastMtime` / `lastPosted` are keyed by agent, so a carried-over agent must
    // keep its de-dup state across the swap rather than re-post an unchanged blob.
    it('does not repost a carried-over agent whose file did not change', async () => {
      await writeFile(path, CLAUDE_BLOB);
      const { relay, post } = fakeRelay();
      const w = watcher(relay);
      await w.scan();
      expect(post).toHaveBeenCalledTimes(1);

      w.setFiles([
        { agent: 'claude', path, shape: 'claude-oauth' },
        { agent: 'codex', path: join(dir, 'absent.json'), shape: 'nonempty-json' },
      ]);
      await w.scan();
      expect(post).toHaveBeenCalledTimes(1);
    });
  });
});

describe('isRetryablePostFailure', () => {
  it('retries transport failures and 5xx, gives up on 4xx except 408/429', () => {
    expect(isRetryablePostFailure({ ok: false, status: null })).toBe(true);
    expect(isRetryablePostFailure({ ok: false, status: 500 })).toBe(true);
    expect(isRetryablePostFailure({ ok: false, status: 503 })).toBe(true);
    expect(isRetryablePostFailure({ ok: false, status: 408 })).toBe(true);
    expect(isRetryablePostFailure({ ok: false, status: 429 })).toBe(true);
    expect(isRetryablePostFailure({ ok: false, status: 400 })).toBe(false);
    expect(isRetryablePostFailure({ ok: false, status: 401 })).toBe(false);
    expect(isRetryablePostFailure({ ok: true, status: 202 })).toBe(false);
  });
});
