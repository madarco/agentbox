import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentboxAliasFor,
  parseSshTarget,
  readAgentboxSshAlias,
  removeAgentboxSshAlias,
  writeAgentboxSshAlias,
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

describe('writeAgentboxSshAlias', () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ab-ssh-cfg-'));
    // On POSIX, `os.homedir()` falls back to `$HOME` when set, which is the
    // hook we use to point the writer at a sandboxed dir.
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function readCfg(): Promise<string> {
    return fs.readFile(join(tmp, '.ssh', 'config'), 'utf8');
  }

  it('emits IdentityFile + IdentitiesOnly when identityFile is set (Hetzner)', async () => {
    await writeAgentboxSshAlias({
      alias: agentboxAliasFor('hz-box'),
      hostname: '1.2.3.4',
      user: 'vscode',
      identityFile: '/box/key',
    });
    const cfg = await readCfg();
    expect(cfg).toContain('Host hz-box');
    expect(cfg).toContain('  IdentityFile /box/key');
    expect(cfg).toContain('  IdentitiesOnly yes');
  });

  it('omits IdentityFile lines when identityFile is undefined (Daytona)', async () => {
    await writeAgentboxSshAlias({
      alias: agentboxAliasFor('dt-box'),
      hostname: 'ssh.app.daytona.io',
      user: 'tok_abc',
    });
    const cfg = await readCfg();
    expect(cfg).toContain('Host dt-box');
    expect(cfg).not.toContain('IdentityFile');
    expect(cfg).not.toContain('IdentitiesOnly');
  });

  it('rewrites in place (no duplicate blocks across calls)', async () => {
    const opts = {
      alias: agentboxAliasFor('hz-box'),
      hostname: '1.2.3.4',
      user: 'vscode',
      identityFile: '/box/key-v1',
    };
    await writeAgentboxSshAlias(opts);
    await writeAgentboxSshAlias({ ...opts, identityFile: '/box/key-v2' });
    const cfg = await readCfg();
    const beginCount = cfg.split('# BEGIN agentbox cloud box hz-box').length - 1;
    expect(beginCount).toBe(1);
    expect(cfg).toContain('/box/key-v2');
    expect(cfg).not.toContain('/box/key-v1');
  });

  it('removeAgentboxSshAlias strips the managed block and leaves others alone', async () => {
    await writeAgentboxSshAlias({
      alias: agentboxAliasFor('hz-box'),
      hostname: '1.2.3.4',
      user: 'vscode',
      identityFile: '/box/key',
    });
    await writeAgentboxSshAlias({
      alias: agentboxAliasFor('dt-box'),
      hostname: 'ssh.app.daytona.io',
      user: 'tok_abc',
    });
    await removeAgentboxSshAlias(agentboxAliasFor('hz-box'));
    const cfg = await readCfg();
    expect(cfg).not.toContain('Host hz-box');
    expect(cfg).toContain('Host dt-box');
  });

  it('readAgentboxSshAlias returns HostName + IdentityFile from a written block', async () => {
    await writeAgentboxSshAlias({
      alias: agentboxAliasFor('hz-box'),
      hostname: '1.2.3.4',
      user: 'vscode',
      identityFile: '/box/key',
    });
    expect(await readAgentboxSshAlias(agentboxAliasFor('hz-box'))).toEqual({
      hostName: '1.2.3.4',
      identityFile: '/box/key',
    });
    expect(await readAgentboxSshAlias('no-such-box')).toBeUndefined();
  });
});
