import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything that touches disk, ssh or the hub is mocked; what is under test is
// the ROLLBACK decision, not the transport. The key dir is real, because the
// bug is precisely about what it leaves on disk: `locallySharedAliases` reads
// `id_ed25519.pub` there and every create-routing gate believes it.
let keyRoot: string;
const ALIAS = 'buildbox';
const hostKeyDir = (alias: string): string => join(keyRoot, alias);
const sshExec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

vi.mock('@agentbox/sandbox-remote-docker', () => ({
  getHostAlias: (alias: string) =>
    alias === ALIAS ? { ssh: 'me@engine', createdAt: 'x' } : undefined,
  listHostAliases: () => [{ alias: ALIAS, ssh: 'me@engine', createdAt: 'x' }],
  hostKeyDir: (alias: string) => hostKeyDir(alias),
  parseRemoteTarget: (ssh: string) => ({ host: ssh.split('@')[1] ?? ssh, user: ssh.split('@')[0] }),
}));
vi.mock('@agentbox/sandbox-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/sandbox-core')>()),
  mintSshKey: async (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'id_ed25519'), 'PRIVATE');
    writeFileSync(join(dir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA agentbox-hub');
    return { publicKey: 'ssh-ed25519 AAAA agentbox-hub', privatePath: join(dir, 'id_ed25519') };
  },
  resolveSshConfigTarget: async () => ({ host: '10.0.0.9', user: 'me' }),
  sshExec: (...args: unknown[]) => sshExec(...(args as [])),
}));
vi.mock('@agentbox/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/config')>()),
  loadEffectiveConfig: vi.fn(),
}));
vi.mock('../src/lib/prompt.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { shareHostWith, locallySharedAliases } =
  await import('../src/control-plane/remote-docker-share.js');

function deps(addHost: () => Promise<void>) {
  return { client: { addHost, removeHost: async () => ({}) } };
}

beforeEach(() => {
  keyRoot = mkdtempSync(join(tmpdir(), 'agentbox-share-'));
  sshExec.mockClear();
});
afterEach(() => rmSync(keyRoot, { recursive: true, force: true }));

describe('shareHostWith', () => {
  it('keeps the minted key when the control box accepts the host', async () => {
    const res = await shareHostWith(
      ALIAS,
      deps(async () => {}),
    );
    expect(res.ok).toBe(true);
    expect(existsSync(join(hostKeyDir(ALIAS), 'id_ed25519.pub'))).toBe(true);
    expect(await locallySharedAliases()).toContain(ALIAS);
  });

  it('rolls the minted key back when the control box refuses', async () => {
    const res = await shareHostWith(
      ALIAS,
      deps(async () => {
        throw new Error('probe failed: engine unreachable from here');
      }),
    );
    expect(res.ok).toBe(false);
    // The pubkey is what `locallySharedAliases` reads, and every create-routing
    // gate trusts it — a refused share must not leave it behind or creates get
    // routed to a hub that has no such alias, with local docker gated off.
    expect(existsSync(hostKeyDir(ALIAS))).toBe(false);
    expect(await locallySharedAliases()).not.toContain(ALIAS);
  });

  it('revokes the grant on the engine as part of that rollback', async () => {
    await shareHostWith(
      ALIAS,
      deps(async () => {
        throw new Error('nope');
      }),
    );
    const commands = sshExec.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(commands.some((c) => c.includes('authorized_keys') && c.includes('grep -vxF'))).toBe(
      true,
    );
  });

  it('leaves the user their own key with --use-existing-key', async () => {
    mkdirSync(hostKeyDir(ALIAS), { recursive: true });
    writeFileSync(join(hostKeyDir(ALIAS), 'id_ed25519.pub'), 'pre-existing');
    const res = await shareHostWith(
      ALIAS,
      deps(async () => {
        throw new Error('nope');
      }),
      { useExistingKey: true },
    );
    expect(res.ok).toBe(false);
    // Nothing was minted here, so nothing is ours to revoke.
    expect(existsSync(join(hostKeyDir(ALIAS), 'id_ed25519.pub'))).toBe(true);
  });
});
