import { mkdtempSync, realpathSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resetTempAgentboxHome } from '../../../scripts/test-home.js';

// Redirect HOME before importing anything that resolves ~/.agentbox — apps/cli
// tests otherwise share the REAL home (see project memory), and adoption writes
// state.json + pulls key material.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-hub-adopt-home-'));
process.env['HOME'] = TEST_HOME;

const { adoptHubBox, normalizeOriginUrl } = await import('../src/control-plane/hub-adopt.js');
const { CustodyClient } = await import('../src/control-plane/custody-client.js');
const { readState } = await import('@agentbox/sandbox-core');

type HubApiBox = import('../src/control-plane/hub-api-client.js').HubApiBox;

const scratch: string[] = [];

afterEach(async () => {
  await resetTempAgentboxHome();
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** A resolved hub box as `GET /api/v1/boxes?ref=` would return it. */
function hubBox(p: Partial<HubApiBox> & { id: string }): HubApiBox {
  return {
    task: p.name ?? p.id,
    provider: 'e2b',
    status: 'running',
    branch: `agentbox/${p.name ?? p.id}`,
    ...p,
  };
}

/** A fake control box serving only the custody surface adoption uses for SSH keys. */
function fakeCustody(custody: Record<string, string> = {}): typeof fetch {
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
  it('rebuilds a hetzner box record from the payload and pulls its ssh keys', async () => {
    const custody = custodyClient(fakeCustody({ 'boxes/sb-42/ssh/id_ed25519': 'PRIVATE-KEY' }));
    const res = await adoptHubBox({
      box: hubBox({
        id: 'brave-otter',
        name: 'brave-otter',
        provider: 'hetzner',
        sandboxId: 'sb-42',
        publicHost: '5.6.7.8',
        image: 'snap-1',
        webPort: 8080,
        lastAgent: 'claude',
        originUrl: 'https://github.com/o/r.git',
        branch: 'agentbox/brave-otter',
      }),
      custody,
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });

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
    const res = await adoptHubBox({
      box: hubBox({
        id: 'p1',
        name: 'plugin-box',
        provider: 'someplugin',
        sandboxId: 'sb-p',
        publicHost: '9.9.9.9',
      }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.record.ssh?.host).toBe('9.9.9.9');
    expect(res.record.ssh?.identityFile).toBeUndefined();
  });

  it('flags an SSH box adopted without its key rather than looking fine', async () => {
    // Regression: the key download is best-effort, so a hetzner box could adopt
    // "successfully" with an identityFile pointing at a key that isn't on disk —
    // surfacing much later as an opaque ssh failure from attach/cp.
    const res = await adoptHubBox({
      box: hubBox({
        id: 'h1',
        name: 'keyless',
        provider: 'hetzner',
        sandboxId: 'sb-nk',
        publicHost: '7.7.7.7',
      }),
      custody: custodyClient(fakeCustody()), // no boxes/sb-nk/ssh/* at all
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.sshFiles).toEqual([]);
    expect(res.sshKeysMissing).toBe(true);
    // Still adopted — `url` works and the key can arrive later.
    expect(res.record.ssh?.identityFile).toBeDefined();
  });

  it('does not flag missing keys for a provider that mints none', async () => {
    const res = await adoptHubBox({
      box: hubBox({ id: 'e1', name: 'sdk-box', provider: 'e2b', sandboxId: 'sb-e' }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.sshKeysMissing).toBe(false);
  });

  it('adopts an e2b box with no key material (SDK-reached, no keypair)', async () => {
    const res = await adoptHubBox({
      box: hubBox({
        id: 'b1',
        name: 'calm-fox',
        provider: 'e2b',
        sandboxId: 'e2b-9',
        webPort: 8080,
      }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.sshFiles).toEqual([]);
    expect(res.record.provider).toBe('e2b');
    expect(res.record.cloud?.sandboxId).toBe('e2b-9');
    // No publicHost → no SSH target invented.
    expect(res.record.ssh).toBeUndefined();
  });

  it('adopts the record without keys when no custody client is available', async () => {
    // A thin client with an API key but no admin token: adopt + `url` still work;
    // an SSH provider is flagged so attach/cp fail loudly, not opaquely.
    const res = await adoptHubBox({
      box: hubBox({
        id: 'h2',
        name: 'no-custody',
        provider: 'hetzner',
        sandboxId: 'sb-nc',
        publicHost: '3.3.3.3',
      }),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.sshFiles).toEqual([]);
    expect(res.sshKeysMissing).toBe(true);
    expect(res.record.ssh?.host).toBe('3.3.3.3');
  });

  it('links the box to a local clone of its repo and rewrites hostMainRepo', async () => {
    const repo = await makeRepo('git@github.com:o/r.git');
    const res = await adoptHubBox({
      // A different URL shape than the local remote: matching must normalize.
      box: hubBox({
        id: 'b2',
        name: 'linked',
        provider: 'e2b',
        sandboxId: 'sb-7',
        originUrl: 'https://github.com/o/r',
        branch: 'agentbox/linked',
      }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: repo,
    });

    expect(res.projectRoot).toBe(repo);
    expect(res.record.projectRoot).toBe(repo);
    expect(res.record.projectIndex).toBe(1);
    expect(res.record.gitWorktrees?.[0]?.hostMainRepo).toBe(repo);
    expect(res.record.gitWorktrees?.[0]?.branch).toBe('agentbox/linked');
  });

  it('adopts without project linkage when the PC has no clone of the repo', async () => {
    const res = await adoptHubBox({
      box: hubBox({
        id: 'b3',
        name: 'orphan',
        provider: 'e2b',
        sandboxId: 'sb-8',
        originUrl: 'git@github.com:o/unknown.git',
      }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });
    expect(res.projectRoot).toBeUndefined();
    expect(res.record.projectRoot).toBeUndefined();
    expect(res.record.gitWorktrees).toBeUndefined();
  });

  it('is idempotent: re-adopting refreshes in place and keeps the box id + tokens', async () => {
    const first = await adoptHubBox({
      box: hubBox({
        id: 'b4',
        name: 'twice',
        provider: 'hetzner',
        sandboxId: 'sb-1',
        publicHost: '1.1.1.1',
      }),
      custody: custodyClient(fakeCustody({ 'boxes/sb-1/ssh/id_ed25519': 'K' })),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });

    // The VM's IP changed (a stop/start reassigns it) — a refresh must pick it up.
    const second = await adoptHubBox({
      box: hubBox({
        id: 'b4',
        name: 'twice',
        provider: 'hetzner',
        sandboxId: 'sb-1',
        publicHost: '2.2.2.2',
      }),
      custody: custodyClient(fakeCustody({ 'boxes/sb-1/ssh/id_ed25519': 'K' })),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });

    expect(second.refreshed).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.relayToken).toBe(first.record.relayToken);
    expect(second.record.cloud?.bridgeToken).toBe(first.record.cloud?.bridgeToken);
    expect(second.record.cloud?.publicHost).toBe('2.2.2.2');
    // Still exactly one row — a refresh must not duplicate the box.
    const state = await readState();
    expect(state.boxes).toHaveLength(1);
  });

  it('lands keys at the path identityFile points to (provider-namespaced dir)', async () => {
    // Regression: the key download used to re-resolve a raw ref, matching only
    // id/name — so a sandbox-id ref lost `provider` and wrote to the default
    // (un-namespaced) dir while identityFile used the provider-namespaced one.
    // DigitalOcean is namespaced; keys must land where the record says.
    const res = await adoptHubBox({
      box: hubBox({
        id: 'do1',
        name: 'do-box',
        provider: 'digitalocean',
        sandboxId: 'drop-77',
        publicHost: '4.4.4.4',
      }),
      custody: custodyClient(fakeCustody({ 'boxes/drop-77/ssh/id_ed25519': 'DOKEY' })),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });

    expect(res.sshFiles).toEqual(['id_ed25519']);
    const identity = res.record.ssh?.identityFile;
    expect(identity).toBeDefined();
    // The key must actually exist where the record says it is.
    expect(await readFile(identity!, 'utf8')).toBe('DOKEY');
  });

  it('never clobbers an unrelated local box that happens to share the name', async () => {
    // Regression: adoption treated a name match as identity, so adopting a hub
    // box called `dupe` would overwrite a local DOCKER box called `dupe` with
    // cloud fields — corrupting the record for a completely different box.
    const { recordBox } = await import('@agentbox/sandbox-docker');
    await recordBox({
      id: 'local-docker-id',
      name: 'dupe',
      provider: 'docker',
      container: 'agentbox-dupe',
      image: 'agentbox/box:dev',
      workspacePath: '/local/ws',
      relayToken: 'local-token',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);

    const res = await adoptHubBox({
      box: hubBox({ id: 'hub-id', name: 'dupe', provider: 'e2b', sandboxId: 'sb-hub' }),
      custody: custodyClient(fakeCustody()),
      controlPlaneUrl: 'http://cb.test',
      cwd: TEST_HOME,
    });

    expect(res.refreshed).toBe(false); // a NEW record, not a takeover
    const state = await readState();
    const docker = state.boxes.find((b) => b.id === 'local-docker-id');
    expect(docker?.provider).toBe('docker');
    expect(docker?.container).toBe('agentbox-dupe');
    expect(docker?.cloud).toBeUndefined();
    // Both records coexist.
    expect(state.boxes).toHaveLength(2);
  });
});
