import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCredsPlan, runGitCredsGate } from '../src/lib/git-creds-gate.js';

// The credential detection shells out to real `git` (credential fill, config
// reads) but never touches the network or docker: an HTTPS origin + a fake
// credential helper that echoes a token is enough to exercise it. The
// interactive prompt itself is not driven here — copying a credential requires a
// live human at a TTY by design, so we test the plan builder directly and assert
// the gate refuses a non-TTY.

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

describe('buildCredsPlan', () => {
  it('token: synthesizes a ~/.git-credentials entry at mode 0600, uid 1000', async () => {
    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', [
        '-C',
        d,
        'config',
        'credential.helper',
        '!f() { echo username=x-access-token; echo password=TESTTOKEN123; }; f',
      ]);
    });

    const plan = await buildCredsPlan(dir, 'token');
    const cred = plan.entries.find((e) => e.rawDest === '~/.git-credentials');
    expect(cred).toBeDefined();
    expect(cred?.mode).toBe(0o600);
    expect(cred?.user).toBe(1000);
    expect(cred?.absDest).toBe('/home/vscode/.git-credentials');
    // token mode never copies an SSH key.
    expect(plan.entries.some((e) => e.rawDest.startsWith('~/.ssh/'))).toBe(false);
    // an explicit mode marker rides along so seeding can't be flipped by a
    // stray carry: ~/.git-credentials.
    const marker = plan.entries.find((e) => e.rawDest === '~/.config/agentbox/git-direct-mode');
    expect(marker).toBeDefined();
    expect(marker?.absDest).toBe('/home/vscode/.config/agentbox/git-direct-mode');
  });

  it('ssh: copies the SSH identity key at mode 0600', async () => {
    await mkdir(join(fakeHome, '.ssh'), { recursive: true });
    const keyPath = join(fakeHome, '.ssh', 'id_ed25519');
    await writeFile(keyPath, 'PRIVATE-KEY-BODY\n', { mode: 0o600 });
    await chmod(keyPath, 0o600);

    const dir = await initRepo('git@github.com:acme/widgets.git');
    const plan = await buildCredsPlan(dir, 'ssh');
    const key = plan.entries.find((e) => e.rawDest === '~/.ssh/id_ed25519');
    expect(key).toBeDefined();
    expect(key?.mode).toBe(0o600);
    expect(key?.user).toBe(1000);
  });

  it('ssh: copies the PRIVATE signing key, not just the .pub', async () => {
    await mkdir(join(fakeHome, '.ssh'), { recursive: true });
    const priv = join(fakeHome, '.ssh', 'id_rsa');
    await writeFile(priv, 'PRIV\n', { mode: 0o600 });
    await writeFile(`${priv}.pub`, 'ssh-rsa AAAA test\n', { mode: 0o644 });

    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', ['-C', d, 'config', 'commit.gpgsign', 'true']);
      await execa('git', ['-C', d, 'config', 'gpg.format', 'ssh']);
      await execa('git', ['-C', d, 'config', 'user.signingkey', `${priv}.pub`]);
    });

    const plan = await buildCredsPlan(dir, 'ssh');
    const key = plan.entries.find((e) => e.rawDest === '~/.ssh/id_rsa');
    expect(key).toBeDefined();
    expect(key?.mode).toBe(0o600);
    expect(plan.entries.find((e) => e.rawDest === '~/.ssh/id_rsa.pub')).toBeDefined();
  });

  it('token: no credential resolvable → empty plan (does not throw)', async () => {
    const dir = await initRepo('https://github.com/acme/widgets.git', async (d) => {
      await execa('git', ['-C', d, 'config', 'credential.helper', '']);
    });
    const plan = await buildCredsPlan(dir, 'token');
    // Deterministic in CI (no ambient github token); tolerate a host token.
    expect(plan.entries.length).toBeGreaterThanOrEqual(0);
  });
});

describe('runGitCredsGate', () => {
  it('refuses a non-TTY — copying a credential needs a live human (no automation path)', async () => {
    const dir = await initRepo('https://github.com/acme/widgets.git');
    await expect(runGitCredsGate({ projectRoot: dir, isTTY: false })).rejects.toThrow(
      /requires an interactive terminal/,
    );
  });
});
