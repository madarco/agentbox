import { mkdtempSync, realpathSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing anything that resolves ~/.agentbox — apps/cli
// tests otherwise share the REAL home (see project memory), and adoption writes
// state.json + pulls key material.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-hub-adopt-home-'));
process.env['HOME'] = TEST_HOME;

const { adoptHubBox, normalizeOriginUrl, HubBoxNotFoundError } = await import(
  '../src/control-plane/hub-adopt.js'
);
const { ControlPlaneAdminClient } = await import('../src/control-plane/admin-client.js');
const { CustodyClient } = await import('../src/control-plane/custody-client.js');
const { readState } = await import('@agentbox/sandbox-core');

const scratch: string[] = [];

afterEach(async () => {
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface FakeReg {
  boxId: string;
  name: string;
  backend?: string;
  sandboxId?: string;
  originUrl?: string;
  publicHost?: string;
  image?: string;
  webPort?: number;
  agent?: string;
  token?: string;
  worktrees?: Array<{ containerPath: string; hostMainRepo: string; branch: string; sanctionedBranch?: string }>;
}

/** A fake control box serving the store RPC + custody surfaces adoption uses. */
function fakeControlBox(opts: { boxes: FakeReg[]; custody?: Record<string, string> }): typeof fetch {
  const custody = opts.custody ?? {};
  return (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url));
    if (u.pathname === '/admin/store') {
      const body = JSON.parse(init?.body ?? '{}') as { method: string };
      if (body.method === 'listBoxes') {
        return json({
          result: opts.boxes.map((b) => ({ registeredAt: new Date().toISOString(), ...b })),
        });
      }
      return json({ result: null });
    }
    if (u.pathname === '/admin/custody') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const entries = Object.keys(custody)
        .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
        .map((p) => ({ path: p, size: custody[p]!.length, sha256: 'x', mode: 0o600, updatedAt: '' }));
      return json({ entries });
    }
    if (u.pathname.startsWith('/admin/custody/')) {
      const path = decodeURIComponent(u.pathname.slice('/admin/custody/'.length));
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

function clients(fetchImpl: typeof fetch) {
  const target = { url: 'http://cb.test', adminToken: 'admin', fetchImpl };
  return {
    admin: new ControlPlaneAdminClient(target),
    custody: new CustodyClient(target),
    controlPlaneUrl: target.url,
  };
}

/**
 * A real git repo with an `origin` remote, so origin-matching runs for real.
 * Returns the realpath: on macOS `/var` is a symlink to `/private/var` and
 * `git rev-parse --show-toplevel` resolves it, so the raw mkdtemp path would
 * never compare equal to what adoption records.
 */
async function makeRepo(origin: string): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-adopt-repo-')));
  scratch.push(dir);
  await execa('git', ['-C', dir, 'init', '-q']);
  await execa('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

describe('normalizeOriginUrl', () => {
  it('treats every git URL shape for the same repo as equal', () => {
    const forms = [
      'https://github.com/madarco/agentbox.git',
      'https://github.com/madarco/agentbox',
      'git@github.com:madarco/agentbox.git',
      'ssh://git@github.com/madarco/agentbox.git',
      'https://github.com/madarco/agentbox/',
    ];
    const normalized = forms.map(normalizeOriginUrl);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('github.com/madarco/agentbox');
  });

  it('does not conflate different repos', () => {
    expect(normalizeOriginUrl('git@github.com:o/a.git')).not.toBe(
      normalizeOriginUrl('git@github.com:o/b.git'),
    );
  });
});

describe('adoptHubBox', () => {
  it('rebuilds a hetzner box record from the registration and pulls its ssh keys', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [
        {
          boxId: 'brave-otter',
          name: 'brave-otter',
          backend: 'hetzner',
          sandboxId: 'sb-42',
          publicHost: '5.6.7.8',
          image: 'snap-1',
          webPort: 8080,
          agent: 'claude',
          originUrl: 'https://github.com/o/r.git',
          worktrees: [
            { containerPath: '/workspace', hostMainRepo: '/tmp/hub-clone', branch: 'agentbox/brave-otter' },
          ],
        },
      ],
      custody: { 'boxes/sb-42/ssh/id_ed25519': 'PRIVATE-KEY' },
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'brave-otter', cwd: TEST_HOME });

    expect(res.refreshed).toBe(false);
    expect(res.sshFiles).toEqual(['id_ed25519']);
    const r = res.record;
    expect(r.provider).toBe('hetzner');
    expect(r.container).toBe('cloud:sb-42');
    expect(r.cloud?.sandboxId).toBe('sb-42');
    expect(r.cloud?.publicHost).toBe('5.6.7.8');
    expect(r.cloud?.webPort).toBe(8080);
    expect(r.cloud?.topology).toBe('control-plane');
    expect(r.cloud?.controlPlaneUrl).toBe('http://cb.test');
    expect(r.lastAgent).toBe('claude');
    // SSH target reconstructed from the registered public IP.
    expect(r.ssh?.host).toBe('5.6.7.8');
    expect(r.ssh?.user).toBe('vscode');
    expect(r.ssh?.identityFile).toContain(join('boxes', 'sb-42', 'ssh', 'id_ed25519'));
    // A hub box clones in-box from a leased URL: no host fork base, so the
    // session-start resync must skip it.
    expect(r.cloud?.hostSeeded).toBeUndefined();
    // Persisted, so `agentbox ls` / resolveBoxOrExit find it.
    const state = await readState();
    expect(state.boxes.map((b) => b.name)).toEqual(['brave-otter']);
  });

  it('omits identityFile when the provider has no per-box key dir', async () => {
    // Regression: `identityFile` was built as `${dir ?? ''}/id_ed25519`, so a
    // provider reporting a publicHost without a keypair (e.g. a plugin) wrote
    // the absolute path `/id_ed25519` into the record and the ssh config.
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'p1', name: 'plugin-box', backend: 'someplugin', sandboxId: 'sb-p', publicHost: '9.9.9.9' }],
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'plugin-box', cwd: TEST_HOME });
    expect(res.record.ssh?.host).toBe('9.9.9.9');
    expect(res.record.ssh?.identityFile).toBeUndefined();
  });

  it('flags an SSH box adopted without its key rather than looking fine', async () => {
    // Regression: the key download is best-effort, so a hetzner box could adopt
    // "successfully" with an identityFile pointing at a key that isn't on disk —
    // surfacing much later as an opaque ssh failure from attach/cp.
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'h1', name: 'keyless', backend: 'hetzner', sandboxId: 'sb-nk', publicHost: '7.7.7.7' }],
      custody: {}, // no boxes/sb-nk/ssh/* at all
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'keyless', cwd: TEST_HOME });
    expect(res.sshFiles).toEqual([]);
    expect(res.sshKeysMissing).toBe(true);
    // Still adopted — `url` works and the key can arrive later.
    expect(res.record.ssh?.identityFile).toBeDefined();
  });

  it('does not flag missing keys for a provider that mints none', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'e1', name: 'sdk-box', backend: 'e2b', sandboxId: 'sb-e' }],
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'sdk-box', cwd: TEST_HOME });
    expect(res.sshKeysMissing).toBe(false);
  });

  it('adopts an e2b box with no key material (SDK-reached, no keypair)', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'b1', name: 'calm-fox', backend: 'e2b', sandboxId: 'e2b-9', webPort: 8080 }],
      custody: {},
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'calm-fox', cwd: TEST_HOME });
    expect(res.sshFiles).toEqual([]);
    expect(res.record.provider).toBe('e2b');
    expect(res.record.cloud?.sandboxId).toBe('e2b-9');
    // No publicHost → no SSH target invented.
    expect(res.record.ssh).toBeUndefined();
  });

  it('links the box to a local clone of its repo and rewrites hostMainRepo', async () => {
    const repo = await makeRepo('git@github.com:o/r.git');
    const fetchImpl = fakeControlBox({
      boxes: [
        {
          boxId: 'b2',
          name: 'linked',
          backend: 'e2b',
          sandboxId: 'sb-7',
          // A different URL shape than the local remote: matching must normalize.
          originUrl: 'https://github.com/o/r',
          worktrees: [
            {
              containerPath: '/workspace',
              // The control box's temp create-time checkout — must NOT survive.
              hostMainRepo: '/tmp/hub-worker-clone-deleted',
              branch: 'agentbox/linked',
            },
          ],
        },
      ],
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'linked', cwd: repo });

    expect(res.projectRoot).toBe(repo);
    expect(res.record.projectRoot).toBe(repo);
    expect(res.record.projectIndex).toBe(1);
    expect(res.record.gitWorktrees?.[0]?.hostMainRepo).toBe(repo);
    expect(res.record.gitWorktrees?.[0]?.branch).toBe('agentbox/linked');
  });

  it('adopts without project linkage when the PC has no clone of the repo', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [
        { boxId: 'b3', name: 'orphan', backend: 'e2b', sandboxId: 'sb-8', originUrl: 'git@github.com:o/unknown.git' },
      ],
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'orphan', cwd: TEST_HOME });
    expect(res.projectRoot).toBeUndefined();
    expect(res.record.projectRoot).toBeUndefined();
    expect(res.record.gitWorktrees).toBeUndefined();
  });

  it('is idempotent: re-adopting refreshes in place and keeps the box id + tokens', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'b4', name: 'twice', backend: 'hetzner', sandboxId: 'sb-1', publicHost: '1.1.1.1' }],
      custody: { 'boxes/sb-1/ssh/id_ed25519': 'K' },
    });
    const first = await adoptHubBox({ ...clients(fetchImpl), ref: 'twice', cwd: TEST_HOME });

    // The VM's IP changed (a stop/start reassigns it) — a refresh must pick it up.
    const moved = fakeControlBox({
      boxes: [{ boxId: 'b4', name: 'twice', backend: 'hetzner', sandboxId: 'sb-1', publicHost: '2.2.2.2' }],
      custody: { 'boxes/sb-1/ssh/id_ed25519': 'K' },
    });
    const second = await adoptHubBox({ ...clients(moved), ref: 'twice', cwd: TEST_HOME });

    expect(second.refreshed).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.relayToken).toBe(first.record.relayToken);
    expect(second.record.cloud?.bridgeToken).toBe(first.record.cloud?.bridgeToken);
    expect(second.record.cloud?.publicHost).toBe('2.2.2.2');
    // Still exactly one row — a refresh must not duplicate the box.
    const state = await readState();
    expect(state.boxes).toHaveLength(1);
  });

  it('lands keys at the path identityFile points to, even for a sandbox-id ref', async () => {
    // Regression: the key download used to re-resolve the raw ref, matching only
    // id/name — so a sandbox-id ref lost `provider` and wrote to the default
    // (un-namespaced) dir while identityFile used the provider-namespaced one.
    // DigitalOcean is namespaced, so it broke; hetzner passed only by luck.
    const fetchImpl = fakeControlBox({
      boxes: [
        { boxId: 'do1', name: 'do-box', backend: 'digitalocean', sandboxId: 'drop-77', publicHost: '4.4.4.4' },
      ],
      custody: { 'boxes/drop-77/ssh/id_ed25519': 'DOKEY' },
    });
    // Adopt BY SANDBOX ID — the case that used to diverge.
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'drop-77', cwd: TEST_HOME });

    expect(res.sshFiles).toEqual(['id_ed25519']);
    const identity = res.record.ssh?.identityFile;
    expect(identity).toBeDefined();
    // The key must actually exist where the record says it is.
    expect(await readFile(identity!, 'utf8')).toBe('DOKEY');
  });

  it('resolves a box by sandbox id as well as by name/id', async () => {
    const fetchImpl = fakeControlBox({
      boxes: [{ boxId: 'b5', name: 'named', backend: 'e2b', sandboxId: 'sb-xyz' }],
    });
    const res = await adoptHubBox({ ...clients(fetchImpl), ref: 'sb-xyz', cwd: TEST_HOME });
    expect(res.record.name).toBe('named');
  });

  it('throws HubBoxNotFoundError for a ref the control box does not know', async () => {
    const fetchImpl = fakeControlBox({ boxes: [] });
    await expect(
      adoptHubBox({ ...clients(fetchImpl), ref: 'ghost', cwd: TEST_HOME }),
    ).rejects.toBeInstanceOf(HubBoxNotFoundError);
  });
});
