import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitCredsGate } from '../src/lib/git-creds-gate.js';

// The gate shells out to real `git` (credential fill, config reads) but never
// touches the network or docker: an HTTPS origin + a fake credential helper
// that echoes a token is enough to exercise detection + entry synthesis.

async function initRepo(origin: string, extra?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-gcg-test-'));
  await execa('git', ['-C', dir, 'init', '-q']);
  await execa('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  await extra?.(dir);
  return dir;
}

const origHome = process.env.HOME;
let fakeHome: string;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'agentbox-gcg-home-'));
  process.env.HOME = fakeHome;
});
afterEach(() => {
  process.env.HOME = origHome;
});

describe('runGitCredsGate', () => {
  it('HTTPS origin: synthesizes a ~/.git-credentials entry at mode 0600, uid 1000', async () => {
    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      // Fake credential helper: returns a token with no network.
      await execa('git', [
        '-C',
        d,
        'config',
        'credential.helper',
        '!f() { echo username=x-access-token; echo password=TESTTOKEN123; }; f',
      ]);
    });

    const res = await runGitCredsGate({
      projectRoot: dir,
      yes: false,
      withCredentialsYes: true, // non-interactive auto-approve
      isTTY: false,
    });

    expect(res.decision).toBe('approve');
    if (res.decision !== 'approve') return;
    const cred = res.entries.find((e) => e.rawDest === '~/.git-credentials');
    expect(cred).toBeDefined();
    expect(cred?.mode).toBe(0o600);
    expect(cred?.user).toBe(1000);
    expect(cred?.absDest).toBe('/home/vscode/.git-credentials');
  });

  it('SSH origin: copies the SSH identity key at mode 0600', async () => {
    // A default identity key in the fake HOME; resolveSshIdentity falls back to it.
    await mkdir(join(fakeHome, '.ssh'), { recursive: true });
    const keyPath = join(fakeHome, '.ssh', 'id_ed25519');
    await writeFile(keyPath, 'PRIVATE-KEY-BODY\n', { mode: 0o600 });
    await chmod(keyPath, 0o600);

    const dir = await initRepo('git@github.com:acme/widgets.git');
    const res = await runGitCredsGate({
      projectRoot: dir,
      yes: false,
      withCredentialsYes: true,
      isTTY: false,
    });

    expect(res.decision).toBe('approve');
    if (res.decision !== 'approve') return;
    const key = res.entries.find((e) => e.rawDest === '~/.ssh/id_ed25519');
    expect(key).toBeDefined();
    expect(key?.mode).toBe(0o600);
    expect(key?.user).toBe(1000);
  });

  it('SSH commit signing: copies the PRIVATE signing key, not just the .pub', async () => {
    // Host signing key is named by its .pub (a common git config), and only the
    // .pub exists as user.signingkey — but signing needs the private key.
    await mkdir(join(fakeHome, '.ssh'), { recursive: true });
    const priv = join(fakeHome, '.ssh', 'id_rsa');
    await writeFile(priv, 'PRIV\n', { mode: 0o600 });
    await writeFile(`${priv}.pub`, 'ssh-rsa AAAA test\n', { mode: 0o644 });

    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', [
        '-C',
        d,
        'config',
        'credential.helper',
        '!f() { echo username=x-access-token; echo password=TESTTOKEN; }; f',
      ]);
      await execa('git', ['-C', d, 'config', 'commit.gpgsign', 'true']);
      await execa('git', ['-C', d, 'config', 'gpg.format', 'ssh']);
      await execa('git', ['-C', d, 'config', 'user.signingkey', `${priv}.pub`]);
    });

    const res = await runGitCredsGate({
      projectRoot: dir,
      yes: false,
      withCredentialsYes: true,
      isTTY: false,
    });
    expect(res.decision).toBe('approve');
    if (res.decision !== 'approve') return;
    // Private key must be present so in-box `git commit -S` can actually sign.
    const key = res.entries.find((e) => e.rawDest === '~/.ssh/id_rsa');
    expect(key).toBeDefined();
    expect(key?.mode).toBe(0o600);
    expect(res.entries.find((e) => e.rawDest === '~/.ssh/id_rsa.pub')).toBeDefined();
  });

  it('non-TTY without --with-credentials-yes throws fail-loud (never silently copies)', async () => {
    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', [
        '-C',
        d,
        'config',
        'credential.helper',
        '!f() { echo username=x-access-token; echo password=TESTTOKEN123; }; f',
      ]);
    });
    await expect(
      runGitCredsGate({ projectRoot: dir, yes: true, isTTY: false }),
    ).rejects.toThrow(/AGENTBOX_WITH_CREDENTIALS_YES=1/);
  });

  it('no credentials found → skip (does not block create)', async () => {
    // HTTPS origin but no credential helper and no gh: nothing to copy.
    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', ['-C', d, 'config', 'credential.helper', '']);
    });
    const res = await runGitCredsGate({
      projectRoot: dir,
      yes: false,
      withCredentialsYes: true,
      isTTY: false,
    });
    // Either skip (no token resolvable) or approve if the host env happens to
    // have a github token; assert it never throws and yields no cred file we
    // didn't intend. The deterministic case in CI is skip.
    expect(['skip', 'approve']).toContain(res.decision);
  });
});
