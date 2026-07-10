import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SYNC_SPECS, isRealAgentCredential } from '@agentbox/sandbox-core';
import type { RelayClient } from '../src/relay-client.js';
import {
  CredentialsWatcher,
  isRealCredentialText,
  WATCHED_CREDENTIALS,
} from '../src/credentials-watcher.js';
import { CREDENTIALS_UPDATED_EVENT } from '../src/types.js';

const CLAUDE_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 123 },
});

function fakeRelay(): { relay: RelayClient; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn();
  return { relay: { enabled: true, post } as unknown as RelayClient, post };
}

describe('WATCHED_CREDENTIALS drift vs @agentbox/sandbox-core registry', () => {
  it('mirrors credential.boxAbsPath and realShape per agent', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      const watched = WATCHED_CREDENTIALS.find((w) => w.agent === spec.id);
      expect(watched, `missing watcher entry for '${spec.id}'`).toBeDefined();
      expect(watched!.path).toBe(spec.credential.boxAbsPath);
      expect(watched!.shape).toBe(spec.credential.realShape);
    }
    expect(WATCHED_CREDENTIALS).toHaveLength(AGENT_SYNC_SPECS.length);
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
    for (const spec of AGENT_SYNC_SPECS) {
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
});
