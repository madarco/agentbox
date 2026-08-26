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
const { CustodyClient } = await import('../src/control-plane/custody-client.js');

type HubApiBox = import('../src/control-plane/hub-api-client.js').HubApiBox;

afterEach(async () => {
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

/** A resolved hub box as `GET /api/v1/boxes?ref=` would return it. */
function hubBox(p: Partial<HubApiBox> & { id: string }): HubApiBox {
  return {
    task: p.name ?? p.id,
    provider: 'hetzner',
    status: 'running',
    branch: `agentbox/${p.name ?? p.id}`,
    ...p,
  };
}

/** A fake control box serving custody list + get (`/admin/custody`). */
function fakeCustody(custody: Record<string, string>): typeof fetch {
  return (async (url: unknown) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/custody') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const entries = Object.keys(custody)
        .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
        .map((p) => ({
          path: p,
          size: custody[p]!.length,
          sha256: 'x',
          mode: 0o600,
          updatedAt: '',
        }));
      return json({ enabled: true, entries });
    }
    if (u.pathname.startsWith('/api/v1/custody/')) {
      const path = decodeURIComponent(u.pathname.slice('/api/v1/custody/'.length));
      const data = custody[path];
      if (data === undefined) return new Response(null, { status: 404 });
      return json({ data: Buffer.from(data, 'utf8').toString('base64') });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function custodyClient(fetchImpl: typeof fetch) {
  return new CustodyClient({
    url: 'http://cb.test',
    apiKey: 'key',
    adminToken: 'admin',
    fetchImpl,
  });
}

describe('pullBoxSshKeys', () => {
  it('downloads a hetzner box ssh keys keyed by sandboxId into ~/.agentbox/boxes/<sandboxId>/ssh', async () => {
    const res = await pullBoxSshKeys({
      custody: custodyClient(
        fakeCustody({
          'boxes/sb-42/ssh/id_ed25519': 'PRIVATE-KEY',
          'boxes/sb-42/ssh/known_hosts': 'HOSTKEY',
        }),
      ),
      box: hubBox({
        id: 'brave-otter',
        name: 'brave-otter',
        provider: 'hetzner',
        sandboxId: 'sb-42',
      }),
    });
    expect(res.key).toBe('sb-42');
    expect(res.files.sort()).toEqual(['id_ed25519', 'known_hosts']);
    // Landed at the un-namespaced hetzner dir attach reads.
    const dest = join(homedir(), '.agentbox', 'boxes', 'sb-42', 'ssh');
    expect(await readFile(join(dest, 'id_ed25519'), 'utf8')).toBe('PRIVATE-KEY');
    // 0600 file mode.
    expect((await stat(join(dest, 'id_ed25519'))).mode & 0o777).toBe(0o600);
  });

  it('falls back to the box id key when the box has no sandboxId', async () => {
    const res = await pullBoxSshKeys({
      custody: custodyClient(fakeCustody({ 'boxes/box-9/ssh/id_ed25519': 'K' })),
      box: hubBox({ id: 'box-9', name: 'nine', provider: 'hetzner' }),
    });
    expect(res.key).toBe('box-9');
    expect(res.files).toEqual(['id_ed25519']);
  });

  it('reports no files for a keyless box', async () => {
    const res = await pullBoxSshKeys({
      custody: custodyClient(fakeCustody({})),
      box: hubBox({ id: 'ghost', name: 'ghost', provider: 'e2b', sandboxId: 'sb-none' }),
    });
    expect(res.files).toEqual([]);
  });
});
