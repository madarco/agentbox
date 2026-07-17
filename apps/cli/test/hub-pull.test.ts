import { mkdtempSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing anything that resolves ~/.agentbox (apps/cli
// tests share the real HOME otherwise — see project memory). `defaultBoxSshDir`
// reads `os.homedir()` per call, so the pulled keys land under TEST_HOME.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-hub-pull-home-'));
process.env['HOME'] = TEST_HOME;

const { pullBoxSshKeys } = await import('../src/control-plane/hub-pull.js');
const { ControlPlaneAdminClient } = await import('../src/control-plane/admin-client.js');
const { CustodyClient } = await import('../src/control-plane/custody-client.js');

afterEach(async () => {
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

/**
 * A fake control box serving the three surfaces `hub pull` uses: the store RPC
 * (`/admin/store` → listBoxes), and custody list + get (`/admin/custody`).
 */
function fakeControlBox(opts: {
  boxes: Array<{ boxId: string; name: string; backend?: string; sandboxId?: string; registeredAt?: string }>;
  custody: Record<string, string>; // path → utf8 contents
}): typeof fetch {
  return (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url));
    if (u.pathname === '/admin/store') {
      const body = JSON.parse(init?.body ?? '{}') as { method: string };
      if (body.method === 'listBoxes') {
        return json({ result: opts.boxes.map((b) => ({ registeredAt: new Date().toISOString(), ...b })) });
      }
      return json({ result: null });
    }
    if (u.pathname === '/admin/custody') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const entries = Object.keys(opts.custody)
        .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
        .map((p) => ({ path: p, size: opts.custody[p]!.length, sha256: 'x', mode: 0o600, updatedAt: '' }));
      return json({ entries });
    }
    if (u.pathname.startsWith('/admin/custody/')) {
      const path = decodeURIComponent(u.pathname.slice('/admin/custody/'.length));
      const data = opts.custody[path];
      if (data === undefined) return new Response(null, { status: 404 });
      return json({ data: Buffer.from(data, 'utf8').toString('base64') });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('pullBoxSshKeys', () => {
  it('downloads a hetzner box ssh keys keyed by sandboxId into ~/.agentbox/boxes/<sandboxId>/ssh', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'brave-otter', name: 'brave-otter', backend: 'hetzner', sandboxId: 'sb-42' }],
      custody: {
        'boxes/sb-42/ssh/id_ed25519': 'PRIVATE-KEY',
        'boxes/sb-42/ssh/known_hosts': 'HOSTKEY',
      },
    });
    const target = { url: 'http://cb.test', adminToken: 'admin', fetchImpl };
    const res = await pullBoxSshKeys({
      admin: new ControlPlaneAdminClient(target),
      custody: new CustodyClient(target),
      box: 'brave-otter',
    });
    expect(res.registered).toBe(true);
    expect(res.key).toBe('sb-42');
    expect(res.files.sort()).toEqual(['id_ed25519', 'known_hosts']);
    // Landed at the un-namespaced hetzner dir attach reads.
    const dest = join(homedir(), '.agentbox', 'boxes', 'sb-42', 'ssh');
    expect(await readFile(join(dest, 'id_ed25519'), 'utf8')).toBe('PRIVATE-KEY');
    // 0600 file mode.
    expect((await stat(join(dest, 'id_ed25519'))).mode & 0o777).toBe(0o600);
  });

  it('resolves the box by name and falls back to the boxId key when no sandboxId', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'box-9', name: 'nine', backend: 'hetzner' }],
      custody: { 'boxes/box-9/ssh/id_ed25519': 'K' },
    });
    const target = { url: 'http://cb.test', adminToken: 'admin', fetchImpl };
    const res = await pullBoxSshKeys({
      admin: new ControlPlaneAdminClient(target),
      custody: new CustodyClient(target),
      box: 'nine',
    });
    expect(res.key).toBe('box-9');
    expect(res.files).toEqual(['id_ed25519']);
  });

  it('resolves the same refs adoption does (sandbox id, unique prefix)', async () => {
    // Regression: pull exact-matched while adopt also took a prefix, so a ref
    // adopt accepted could make pull miss the registration, lose `provider`, and
    // write the keys under the raw ref instead of the box's sandbox id.
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'a1b2c3', name: 'pref', backend: 'hetzner', sandboxId: 'sb-77' }],
      custody: { 'boxes/sb-77/ssh/id_ed25519': 'K' },
    });
    const target = { url: 'http://cb.test', adminToken: 'admin', fetchImpl };
    for (const ref of ['sb-77', 'a1b2']) {
      const res = await pullBoxSshKeys({
        admin: new ControlPlaneAdminClient(target),
        custody: new CustodyClient(target),
        box: ref,
      });
      expect(res.registered, ref).toBe(true);
      expect(res.key, ref).toBe('sb-77');
      expect(res.files, ref).toEqual(['id_ed25519']);
    }
  });

  it('reports no files for an unregistered / keyless box', async () => {
    const fetchImpl = fakeControlBox({ boxes: [], custody: {} });
    const target = { url: 'http://cb.test', adminToken: 'admin', fetchImpl };
    const res = await pullBoxSshKeys({
      admin: new ControlPlaneAdminClient(target),
      custody: new CustodyClient(target),
      box: 'ghost',
    });
    expect(res.registered).toBe(false);
    expect(res.files).toEqual([]);
  });
});
