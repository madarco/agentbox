import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTBOX_HUB_SSH_ALIAS,
  agentboxAliasFor,
  agentboxSshConfigPath,
  controlPlaneDeployPath,
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
    ssh: { host, user: 'vscode', identityFile: `/box/${name}/key` },
    cloud: {
      backend: 'hetzner',
      sandboxId: name,
    },
  });

  it('writes one Host block per box with a resolved box.ssh target', async () => {
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

  it('emits a Port line for a docker box with a loopback sshd target', async () => {
    await writeState([
      {
        id: 'id-dk',
        name: 'dk',
        provider: 'docker',
        container: 'agentbox-dk',
        image: 'i',
        workspacePath: '/x',
        createdAt: 'now',
        ssh: { host: '127.0.0.1', user: 'vscode', identityFile: '/box/dk/key', port: 54321 },
      },
    ]);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg).toContain('Host dk');
    expect(cfg).toContain('  HostName 127.0.0.1');
    expect(cfg).toContain('  Port 54321');
    expect(cfg).toContain('  IdentityFile /box/dk/key');
  });

  it('skips boxes without a resolved box.ssh (docker or cloud)', async () => {
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

  async function writeDeploy(record: Record<string, unknown>): Promise<void> {
    const path = controlPlaneDeployPath();
    await fs.mkdir(join(tmp, '.agentbox', 'control-plane'), { recursive: true });
    await fs.writeFile(path, JSON.stringify(record, null, 2));
  }

  const deployRecord = {
    provider: 'hetzner',
    url: 'https://1.2.3.4.sslip.io',
    serverId: 42,
    ip: '1.2.3.4',
    domain: '1.2.3.4.sslip.io',
    firewallId: 7,
    sshKeyDir: '/home/u/.agentbox/control-plane/ssh/abc',
  };

  it('adds a control-box Host block from the deploy record', async () => {
    await writeState([]);
    await writeDeploy(deployRecord);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg).toContain(`Host ${AGENTBOX_HUB_SSH_ALIAS}`);
    expect(cfg).toContain('  HostName 1.2.3.4');
    expect(cfg).toContain('  User root');
    expect(cfg).toContain('  IdentityFile /home/u/.agentbox/control-plane/ssh/abc/id_ed25519');
    expect(cfg).toContain('# BEGIN agentbox control box agentbox-hub');
  });

  it('omits the control-box block with no deploy record', async () => {
    await writeState([hzBox('hz1', '1.2.3.4')]);
    await syncAgentboxSshConfig();
    expect(await readOwned()).not.toContain(`Host ${AGENTBOX_HUB_SSH_ALIAS}`);
  });

  it('omits the control-box block when the record predates sshKeyDir', async () => {
    await writeState([]);
    await writeDeploy({ provider: 'hetzner', ip: '1.2.3.4' });
    await syncAgentboxSshConfig();
    expect(await readOwned()).not.toContain(`Host ${AGENTBOX_HUB_SSH_ALIAS}`);
  });

  it('never emits a duplicate Host when a box claims the hub alias', async () => {
    await writeState([hzBox(AGENTBOX_HUB_SSH_ALIAS, '9.9.9.9')]);
    await writeDeploy(deployRecord);
    await syncAgentboxSshConfig();
    const cfg = await readOwned();
    expect(cfg.split(`Host ${AGENTBOX_HUB_SSH_ALIAS}`).length - 1).toBe(1);
    // The box (user-created, more specific) wins — OpenSSH takes the first match.
    expect(cfg).toContain('  HostName 9.9.9.9');
  });

  it('drops the control-box block when the deploy record is removed', async () => {
    await writeState([]);
    await writeDeploy(deployRecord);
    await syncAgentboxSshConfig();
    await fs.rm(controlPlaneDeployPath());
    await syncAgentboxSshConfig();
    expect(await readOwned()).not.toContain(`Host ${AGENTBOX_HUB_SSH_ALIAS}`);
  });
});
