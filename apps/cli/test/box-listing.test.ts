import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTempAgentboxHome } from '../../../scripts/test-home.js';

// Redirect HOME before importing anything that resolves ~/.agentbox — the box
// listing cache lives there and apps/cli tests share the real home otherwise.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-box-listing-home-'));
process.env['HOME'] = TEST_HOME;

// Mutable resolver behavior, hoisted so the vi.mock factories (hoisted above the
// imports) can reach it. The heavy real modules never load — the mock replaces
// them, which is the whole point of unit-testing the offline path.
const state = vi.hoisted(() => ({
  probe: { mode: 'local', url: 'http://127.0.0.1:59999', token: 't' } as {
    mode: 'local' | 'remote';
    url: string;
    token: string;
  } | null,
  target: null as { url: string; apiKey: string } | null,
}));
vi.mock('../src/commands/hub.js', () => ({ resolveHubTarget: async () => state.probe }));
vi.mock('../src/commands/control-plane.js', () => ({
  resolveHubApiTarget: async () => state.target,
}));

async function writeCache(boxes: unknown[], fetchedAt: string): Promise<void> {
  const { hubBoxesCachePath } = await import('../src/control-plane/hub-list.js');
  const path = hubBoxesCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, fetchedAt, boxes }));
}

beforeEach(() => {
  // Fresh module registry each test → a fresh in-process memo, so one test's
  // memoized listing can't leak into the next.
  vi.resetModules();
  state.probe = { mode: 'local', url: 'http://127.0.0.1:59999', token: 't' };
  state.target = null; // default: unresolvable → the cache/offline path
});
afterEach(async () => {
  await resetTempAgentboxHome();
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe('fetchBoxListing offline fallback', () => {
  it('serves the cached payload marked stale when the hub is unreachable', async () => {
    await writeCache(
      [{ id: 'b1', name: 'api', provider: 'docker', status: 'running' }],
      '2026-07-29T12:00:00.000Z',
    );
    const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
    const listing = await fetchBoxListing();
    expect(listing.stale).toBe(true);
    expect(listing.fetchedAt).toBe('2026-07-29T12:00:00.000Z');
    expect(listing.boxes.map((b) => b.id)).toEqual(['b1']);
  });

  it('reports an empty stale listing (no fetchedAt) when there is no cache', async () => {
    const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
    const listing = await fetchBoxListing();
    expect(listing).toEqual({ boxes: [], stale: true });
  });

  it('flags a configured control box with no API key as no-token', async () => {
    state.probe = { mode: 'remote', url: 'https://hub.example', token: '' };
    const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
    const listing = await fetchBoxListing();
    expect(listing).toEqual({ boxes: [], stale: true, reason: 'no-token' });
  });

  it('a 401 from a remote hub is "this computer was removed", not "unreachable"', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'Missing or invalid credentials.' },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    try {
      // Even with a cache on disk: a revoked PC must not be shown old boxes as if
      // the hub were merely down.
      await writeCache(
        [{ id: 'b1', name: 'api', provider: 'docker', status: 'running' }],
        '2026-07-29T12:00:00.000Z',
      );
      state.probe = { mode: 'remote', url, token: 'abdev_revoked' };
      state.target = { url, apiKey: 'abdev_revoked' };
      const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
      expect(await fetchBoxListing()).toEqual({
        boxes: [],
        stale: true,
        reason: 'unauthorized',
        hubUrl: url,
      });
    } finally {
      server.close();
    }
  });

  it('the hint names the hub and the commands to run', async () => {
    const { hubUnauthorizedHint } = await import('../src/control-plane/unauthorized-hint.js');
    const hint = hubUnauthorizedHint('https://hub.example/', 'remote');
    expect(hint).toContain('https://hub.example');
    expect(hint).toContain('agentbox hub login https://hub.example');
    expect(hint).toContain('agentbox hub logout');
    expect(hubUnauthorizedHint(undefined, 'local')).toContain('agentbox hub restart');
  });

  it('ignores a cache written in the old registration schema', async () => {
    // The API cache re-keys hub-boxes-cache.json onto `boxes`; a stale
    // `{ registrations }` file from a pre-upgrade CLI must not be misread.
    const { hubBoxesCachePath } = await import('../src/control-plane/hub-list.js');
    await mkdir(dirname(hubBoxesCachePath()), { recursive: true });
    await writeFile(
      hubBoxesCachePath(),
      JSON.stringify({
        version: 1,
        fetchedAt: '2026-07-29T12:00:00.000Z',
        registrations: [{ boxId: 'x' }],
      }),
    );
    const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
    const listing = await fetchBoxListing();
    expect(listing).toEqual({ boxes: [], stale: true });
  });
});
