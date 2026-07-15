import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// HOME redirect before importing the helper (it resolves ~/.agentbox per call).
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-custody-ssh-home-'));
process.env['HOME'] = TEST_HOME;

const { pushBoxSshToCustody } = await import('../src/custody-ssh.js');
const { boxSshDirForProvider } = await import('@agentbox/sandbox-core');

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe('pushBoxSshToCustody', () => {
  it('PUTs every ssh file to custody boxes/<sandboxId>/ssh keyed by sandboxId', async () => {
    const dir = boxSshDirForProvider('hetzner', 'sb-7')!;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'id_ed25519'), 'PRIV');
    await writeFile(join(dir, 'known_hosts'), 'HK');

    const puts: Array<{ path: string; data: string }> = [];
    const fetchImpl = (async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url));
      const path = decodeURIComponent(u.pathname.slice('/admin/custody/'.length));
      const body = JSON.parse(init?.body ?? '{}') as { data: string };
      puts.push({ path, data: Buffer.from(body.data, 'base64').toString('utf8') });
      return new Response(JSON.stringify({ changed: true, sha256: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;

    const n = await pushBoxSshToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      provider: 'hetzner',
      sandboxId: 'sb-7',
      fetchImpl,
    });
    expect(n).toBe(2);
    const byPath = new Map(puts.map((p) => [p.path, p.data]));
    expect(byPath.get('boxes/sb-7/ssh/id_ed25519')).toBe('PRIV');
    expect(byPath.get('boxes/sb-7/ssh/known_hosts')).toBe('HK');
  });

  it('is a no-op for a provider that mints no keypair (e2b)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const n = await pushBoxSshToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      provider: 'e2b',
      sandboxId: 'sb-e2b',
      fetchImpl,
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });
});
