import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentboxAliasFor,
  agentboxSshConfigPath,
  ensureSshInclude,
  hasUnmanagedHostConflict,
  parseSshTarget,
  readAgentboxSshAlias,
  syncAgentboxSshConfig,
} from '../src/ssh-config.js';

describe('agentboxAliasFor', () => {
  it('uses the box name as the SSH host alias', () => {
    expect(agentboxAliasFor('hz-box')).toBe('hz-box');
  });
});

describe('parseSshTarget', () => {
  it('extracts user, host, and identity file from a Hetzner-style argv', () => {
    const argv = [
      'ssh',
      '-i', '/box/key',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ControlPath=/box/sock',
      'vscode@1.2.3.4',
    ];
    expect(parseSshTarget(argv)).toEqual({
      user: 'vscode',
      host: '1.2.3.4',
      identityFile: '/box/key',
    });
  });

  it('returns identityFile undefined when argv has no -i (Daytona token auth)', () => {
    const argv = ['ssh', '-o', 'StrictHostKeyChecking=accept-new', 'tok_abc@ssh.app.daytona.io'];
    const r = parseSshTarget(argv);
    expect(r?.user).toBe('tok_abc');
    expect(r?.host).toBe('ssh.app.daytona.io');
    expect(r?.identityFile).toBeUndefined();
  });

  it('returns undefined when argv has no user@host token', () => {
    expect(parseSshTarget(['ssh', '-V'])).toBeUndefined();
  });
});

describe('syncAgentboxSshConfig + Include model', () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ab-ssh-cfg-'));
    // On POSIX, `os.homedir()` falls back to `$HOME` when set — the hook that
    // points the writer (and `state.json` reader) at a sandboxed home. Critical:
    // apps/cli tests share the real HOME by default, so a stray write here would
    // clobber the user's ~/.ssh and ~/.agentbox.
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function writeState(boxes: unknown[]): Promise<void> {
    await fs.mkdir(join(tmp, '.agentbox'), { recursive: true });
    await fs.writeFile(
      join(tmp, '.agentbox', 'state.json'),
      JSON.stringify({ version: 1, boxes }, null, 2),
    );
  }
  const readOwned = (): Promise<string> => fs.readFile(agentboxSshConfigPath(), 'utf8');
  const readSsh = (): Promise<string> => fs.readFile(join(tmp, '.ssh', 'config'), 'utf8');

  const hzBox = (name: string, host: string): Record<string, unknown> => ({
    id: `id-${name}`,
    name,
    provider: 'hetzner',
    container: `cloud:${name}`,
    image: 'snap',
    workspacePath: '/x',
    createdAt: 'now',
    cloud: {
      backend: 'hetzner',
      sandboxId: name,
      ssh: { host, user: 'vscode', identityFile: `/box/${name}/key` },
    },
  });

  it('writes one Host block per box with a resolved cloud.ssh target', async () => {
    await writeState([hzBox('hz1', '1.2.3.4'), hzBox('hz2', '5.6.7.8')]);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg).toContain('Host hz1');
    expect(cfg).toContain('  HostName 1.2.3.4');
    expect(cfg).toContain('  IdentityFile /box/hz1/key');
    expect(cfg).toContain('  IdentitiesOnly yes');
    expect(cfg).toContain('Host hz2');
    expect(cfg).toContain('  HostName 5.6.7.8');
  });

  it('skips docker boxes and cloud boxes without a resolved cloud.ssh', async () => {
    await writeState([
      hzBox('hz1', '1.2.3.4'),
      {
        id: 'id-dk',
        name: 'dk',
        provider: 'docker',
        container: 'agentbox-dk',
        image: 'i',
        workspacePath: '/x',
        createdAt: 'now',
        docker: { image: 'i' },
      },
      {
        id: 'id-nossh',
        name: 'nossh',
        provider: 'hetzner',
        container: 'cloud:nossh',
        image: 'i',
        workspacePath: '/x',
        createdAt: 'now',
        cloud: { backend: 'hetzner', sandboxId: 'nossh' },
      },
    ]);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg).toContain('Host hz1');
    expect(cfg).not.toContain('Host dk');
    expect(cfg).not.toContain('Host nossh');
  });

  it('adds a single managed Include block to ~/.ssh/config, idempotently', async () => {
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    await syncAgentboxSshConfig();
    const ssh = await readSsh();
    expect(ssh.split(`Include ${agentboxSshConfigPath()}`).length - 1).toBe(1);
    expect(ssh.split('# BEGIN agentbox ssh include').length - 1).toBe(1);
  });

  it('prepends the Include above existing user content, preserving it', async () => {
    await fs.mkdir(join(tmp, '.ssh'), { recursive: true });
    await fs.writeFile(join(tmp, '.ssh', 'config'), 'Host myserver\n  HostName 9.9.9.9\n');
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    const ssh = await readSsh();
    expect(ssh.indexOf('# BEGIN agentbox ssh include')).toBeLessThan(ssh.indexOf('Host myserver'));
    expect(ssh).toContain('Host myserver');
  });

  it('strips legacy inline `agentbox cloud box` blocks, keeping user blocks', async () => {
    await fs.mkdir(join(tmp, '.ssh'), { recursive: true });
    const legacy =
      '# BEGIN agentbox cloud box old\nHost old\n  HostName 7.7.7.7\n# END agentbox cloud box old\n';
    await fs.writeFile(
      join(tmp, '.ssh', 'config'),
      legacy + 'Host keepme\n  HostName 8.8.8.8\n',
    );
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    const ssh = await readSsh();
    expect(ssh).not.toContain('# BEGIN agentbox cloud box old');
    expect(ssh).not.toContain('Host old');
    expect(ssh).toContain('Host keepme');
  });

  it('regenerate drops a box no longer in state', async () => {
    await writeState([hzBox('hz1', '1.2.3.4'), hzBox('hz2', '5.6.7.8')]);
    await syncAgentboxSshConfig();
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg).toContain('Host hz1');
    expect(cfg).not.toContain('Host hz2');
  });

  it('readAgentboxSshAlias returns HostName + IdentityFile from the owned file', async () => {
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    expect(await readAgentboxSshAlias('hz1')).toEqual({
      hostName: '1.2.3.4',
      identityFile: '/box/hz1/key',
    });
    expect(await readAgentboxSshAlias('nope')).toBeUndefined();
  });

  it('hasUnmanagedHostConflict flags a user-authored Host but not our Include', async () => {
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    expect(await hasUnmanagedHostConflict('hz1')).toBe(false);
    await fs.appendFile(join(tmp, '.ssh', 'config'), '\nHost mybox other\n  HostName 5.6.7.8\n');
    expect(await hasUnmanagedHostConflict('mybox')).toBe(true);
  });

  it('ensureSshInclude adds the Include even with no boxes yet', async () => {
    await ensureSshInclude();
    const ssh = await readSsh();
    expect(ssh).toContain(`Include ${agentboxSshConfigPath()}`);
  });
});
