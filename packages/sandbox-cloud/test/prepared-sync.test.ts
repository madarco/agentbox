import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing anything that resolves ~/.agentbox — prepared
// state lives there and these tests write it.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-prepared-sync-home-'));
process.env['HOME'] = TEST_HOME;

const { preparedCustodyPath, pullPreparedFromCustody, pushPreparedToCustody } = await import(
  '../src/prepared-sync.js'
);
const { readPreparedStateRaw, writePreparedStateRaw } = await import('@agentbox/sandbox-core');

afterEach(async () => {
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

function record(contextSha256: string, imageRef: unknown = 'snap-1') {
  return {
    schema: 1,
    base: {
      imageRef,
      contextSha256,
      cliVersion: '1.0.0',
      createdAt: '2026-07-17T00:00:00.000Z',
    },
  };
}

/** A fake custody surface: serves `stored` on GET, records PUTs. */
function fakeCustody(stored: Record<string, unknown> = {}) {
  const puts: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const path = decodeURIComponent(new URL(String(url)).pathname.slice('/admin/custody/'.length));
    if (init?.method === 'PUT') {
      const parsed = JSON.parse(init.body ?? '{}') as { data: string };
      puts.push({ path, body: JSON.parse(Buffer.from(parsed.data, 'base64').toString('utf8')) });
      return new Response(JSON.stringify({ changed: true, sha256: 'x' }), { status: 200 });
    }
    const value = stored[path];
    if (value === undefined) return new Response(null, { status: 404 });
    return new Response(
      JSON.stringify({ data: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, puts };
}

const target = (fetchImpl: typeof fetch) => ({
  controlPlaneUrl: 'http://cb.test',
  adminToken: 'admin',
  fetchImpl,
});

describe('preparedCustodyPath', () => {
  it('addresses one record per provider under the prepared scope', () => {
    expect(preparedCustodyPath('hetzner')).toBe('prepared/hetzner.json');
  });
});

describe('pushPreparedToCustody', () => {
  it('uploads the local bake record', async () => {
    writePreparedStateRaw('hetzner', record(FINGERPRINT, 42));
    const { fetchImpl, puts } = fakeCustody();
    await expect(pushPreparedToCustody('hetzner', target(fetchImpl))).resolves.toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe('prepared/hetzner.json');
    expect(puts[0]!.body).toMatchObject({ base: { imageRef: 42, contextSha256: FINGERPRINT } });
  });

  it('uploads nothing when this machine has no bake', async () => {
    const { fetchImpl, puts } = fakeCustody();
    await expect(pushPreparedToCustody('e2b', target(fetchImpl))).resolves.toBe(false);
    expect(puts).toEqual([]);
  });

  it('reports failure rather than throwing when the control box rejects it', async () => {
    writePreparedStateRaw('hetzner', record(FINGERPRINT));
    const fetchImpl = (() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;
    await expect(pushPreparedToCustody('hetzner', target(fetchImpl))).resolves.toBe(false);
  });
});

describe('pullPreparedFromCustody', () => {
  it('adopts a record baked from the same build context', async () => {
    const { fetchImpl } = fakeCustody({ 'prepared/hetzner.json': record(FINGERPRINT, 99) });
    const res = await pullPreparedFromCustody('hetzner', FINGERPRINT, target(fetchImpl));
    expect(res.adopted).toBe(true);
    // Written locally, so the provider's own ensure-base gate now passes.
    expect(readPreparedStateRaw('hetzner')).toMatchObject({ base: { imageRef: 99 } });
  });

  it('ignores a record baked from a different build context', async () => {
    const { fetchImpl } = fakeCustody({ 'prepared/hetzner.json': record(OTHER_FINGERPRINT) });
    const res = await pullPreparedFromCustody('hetzner', FINGERPRINT, target(fetchImpl));
    expect(res.adopted).toBe(false);
    expect(res.mismatch).toEqual({ stored: OTHER_FINGERPRINT, current: FINGERPRINT });
    // A stale base must never be written — the caller re-bakes instead.
    expect(readPreparedStateRaw('hetzner')).toBeNull();
  });

  it('adopts nothing when we cannot compute our own fingerprint', async () => {
    const { fetchImpl } = fakeCustody({ 'prepared/hetzner.json': record(FINGERPRINT) });
    // Booting from a base we can't verify is worse than re-baking.
    const res = await pullPreparedFromCustody('hetzner', undefined, target(fetchImpl));
    expect(res.adopted).toBe(false);
    expect(readPreparedStateRaw('hetzner')).toBeNull();
  });

  it('adopts nothing when the control box has no record (404)', async () => {
    const { fetchImpl } = fakeCustody();
    await expect(pullPreparedFromCustody('e2b', FINGERPRINT, target(fetchImpl))).resolves.toEqual({
      adopted: false,
    });
  });

  it('treats a 400 from an older control box like "nothing shared"', async () => {
    // A control box predating the `prepared` scope rejects the path outright.
    const fetchImpl = (() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch;
    await expect(pullPreparedFromCustody('e2b', FINGERPRINT, target(fetchImpl))).resolves.toEqual({
      adopted: false,
    });
  });

  it('falls through to a normal bake when the control box is unreachable', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(pullPreparedFromCustody('e2b', FINGERPRINT, target(fetchImpl))).resolves.toEqual({
      adopted: false,
    });
  });

  it('round-trips a bake from one machine to another', async () => {
    // Machine A bakes and shares.
    writePreparedStateRaw('e2b', record(FINGERPRINT, 'tpl-abc'));
    const { fetchImpl, puts } = fakeCustody();
    await pushPreparedToCustody('e2b', target(fetchImpl));

    // Machine B: same CLI (same fingerprint), nothing baked locally.
    await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
    expect(readPreparedStateRaw('e2b')).toBeNull();
    const { fetchImpl: fetchB } = fakeCustody({ 'prepared/e2b.json': puts[0]!.body });
    const res = await pullPreparedFromCustody('e2b', FINGERPRINT, target(fetchB));

    expect(res.adopted).toBe(true);
    expect(readPreparedStateRaw('e2b')).toMatchObject({ base: { imageRef: 'tpl-abc' } });
  });
});
