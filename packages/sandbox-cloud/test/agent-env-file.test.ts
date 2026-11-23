import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import {
  CLOUD_AGENT_ENV_FILE,
  buildCloudAttachInnerCommand,
  removeCloudAgentEnvFile,
  renderAgentEnvFile,
  writeCloudAgentEnvFile,
} from '../src/index.js';
import { buildBootstrapEnv, type KickCloudBootstrapArgs } from '../src/bootstrap-launch.js';

const SECRET = "sk-dummy-'quoted' $HOME `x` \\ end";

describe('renderAgentEnvFile', () => {
  it('round-trips awkward values through `set -a; .` without expanding them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
    try {
      const file = join(dir, 'agent.env');
      writeFileSync(file, renderAgentEnvFile({ ANTHROPIC_API_KEY: SECRET, MULTI: 'a\nb' }));
      const out = execFileSync(
        'bash',
        ['-c', `set -a; . ${file}; set +a; printf %s "$ANTHROPIC_API_KEY|$MULTI"`],
        { encoding: 'utf8' },
      );
      expect(out).toBe(`${SECRET}|a\nb`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops a key that is not a shell identifier', () => {
    expect(renderAgentEnvFile({ 'BAD;rm -rf /': 'x', OK: 'y' })).toBe(
      `[ -n "\${OK+x}" ] || export OK='y'\n`,
    );
  });

  it('never overrides a key the sandbox env already has, but fills the missing ones', () => {
    // An SDK box keeps its create-time auth when a wake comes from a shell
    // exporting a different key; a VPS (no sandbox env) still gets it.
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
    try {
      const file = join(dir, 'agent.env');
      writeFileSync(file, renderAgentEnvFile({ ANTHROPIC_API_KEY: 'from-wake', EXTRA: 'filled' }));
      const out = execFileSync(
        'bash',
        ['-c', `set -a; . ${file}; set +a; printf %s "$ANTHROPIC_API_KEY|$EXTRA|$EMPTY"`],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: 'from-create', EMPTY: '' },
        },
      );
      expect(out).toBe('from-create|filled|');
      // Exported, so the exec'd agent inherits it.
      const child = execFileSync('bash', ['-c', `. ${file}; bash -c 'printf %s "$EXTRA"'`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(child).toBe('filled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeCloudAgentEnvFile', () => {
  it('ships the values as a 0600 file, never on the exec command line', async () => {
    const execs: string[] = [];
    let uploaded = '';
    let uploadedMode = 0;
    const backend = {
      async uploadFile(_h: CloudHandle, local: string) {
        uploaded = readFileSync(local, 'utf8');
        uploadedMode = statSync(local).mode & 0o777;
      },
      async exec(_h: CloudHandle, cmd: string) {
        execs.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await writeCloudAgentEnvFile(backend, {} as CloudHandle, { OPENAI_API_KEY: SECRET });
    expect(uploaded).toContain('OPENAI_API_KEY=');
    expect(uploadedMode).toBe(0o600);
    expect(execs).toHaveLength(1);
    expect(execs[0]).not.toContain('sk-dummy');
    expect(execs[0]).toContain(`install -m 600`);
    expect(execs[0]).toContain(CLOUD_AGENT_ENV_FILE);
  });

  it('stages on tmpfs /run/agentbox, falling back to /tmp when the upload cannot write there', async () => {
    const targets: string[] = [];
    const ok = {
      async uploadFile(_h: CloudHandle, _l: string, remote: string) {
        targets.push(remote);
      },
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await writeCloudAgentEnvFile(ok, {} as CloudHandle, { A: 'b' });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(/^\/run\/agentbox\/\.agent-env-[0-9a-f]+$/);

    targets.length = 0;
    const execs: string[] = [];
    const runDenied = {
      async uploadFile(_h: CloudHandle, _l: string, remote: string) {
        targets.push(remote);
        if (remote.startsWith('/run/')) throw new Error('permission denied');
      },
      async exec(_h: CloudHandle, cmd: string) {
        execs.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await writeCloudAgentEnvFile(runDenied, {} as CloudHandle, { A: 'b' });
    expect(targets).toHaveLength(2);
    expect(targets[1]).toMatch(/^\/tmp\/\.agent-env-[0-9a-f]+$/);
    expect(execs[0]).toContain(`install -m 600 ${targets[1]} `);
  });

  it('removes both staging paths when the first upload writes the file and then throws', async () => {
    // Daytona: the /run upload lands a 0644 copy and still throws; /run there
    // is not tmpfs, so a snapshot would carry the secret.
    const targets: string[] = [];
    const execs: string[] = [];
    const backend = {
      async uploadFile(_h: CloudHandle, _l: string, remote: string) {
        targets.push(remote);
        if (remote.startsWith('/run/')) throw new Error('wrote, then failed');
      },
      async exec(_h: CloudHandle, cmd: string) {
        execs.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await writeCloudAgentEnvFile(backend, {} as CloudHandle, { GEMINI_API_KEY: SECRET });
    expect(execs).toHaveLength(1);
    const cmd = execs[0]!;
    // chmod before anything else touches the staging copy
    expect(cmd.indexOf(`chmod 600 ${targets[1]}`)).toBeGreaterThan(-1);
    expect(cmd.indexOf(`chmod 600 ${targets[1]}`)).toBeLessThan(cmd.indexOf('install -m 600'));
    expect(cmd).toContain(`rm -f ${targets[0]} ${targets[1]}`);
    expect(cmd.indexOf(`rm -f ${targets[0]}`)).toBeGreaterThan(cmd.indexOf('install -m 600'));
    expect(cmd).not.toContain('sk-dummy');
  });

  it('sweeps staging copies left by earlier failed writes', async () => {
    const execs: string[] = [];
    const backend = {
      async uploadFile() {},
      async exec(_h: CloudHandle, cmd: string) {
        execs.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await writeCloudAgentEnvFile(backend, {} as CloudHandle, { A: 'b' });
    expect(execs[0]).toMatch(/find \/run\/agentbox \/tmp -maxdepth 1 -type f/);
    expect(execs[0]).toContain(`-name '.agent-env-*'`);
    expect(execs[0]).toContain(`-name 'agentbox.agent-env-*'`);
    expect(execs[0]).toContain('-delete');
  });

  it('still removes both staging paths when every upload throws', async () => {
    const targets: string[] = [];
    const execs: string[] = [];
    const backend = {
      async uploadFile(_h: CloudHandle, _l: string, remote: string) {
        targets.push(remote);
        throw new Error(`upload to ${remote} failed`);
      },
      async exec(_h: CloudHandle, cmd: string) {
        execs.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudBackend;
    await expect(writeCloudAgentEnvFile(backend, {} as CloudHandle, { A: 'b' })).rejects.toThrow(
      /upload to \/tmp/,
    );
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain(`rm -f ${targets[0]} ${targets[1]}`);
    expect(execs[0]).not.toContain('install');
  });

  it('surfaces the upload error, not a failing cleanup exec', async () => {
    const backend = {
      async uploadFile() {
        throw new Error('upload broke');
      },
      async exec() {
        throw new Error('exec broke');
      },
    } as unknown as CloudBackend;
    await expect(writeCloudAgentEnvFile(backend, {} as CloudHandle, {})).rejects.toThrow(
      /upload broke/,
    );
  });

  it('runs under a real shell: no staging copy survives, old leftovers are swept, agent.env is 0600', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-env-shell-'));
    try {
      const run = join(root, 'run/agentbox');
      const tmp = join(root, 'tmp');
      mkdirSync(run, { recursive: true });
      mkdirSync(tmp);
      const old = new Date(Date.now() - 10 * 60_000);
      for (const f of [
        `${run}/.agent-env-old1`,
        `${tmp}/.agent-env-old2`,
        `${tmp}/agentbox.agent-env-old3`,
      ]) {
        writeFileSync(f, 'stale');
        utimesSync(f, old, old);
      }
      // A concurrent write's staging copy: too young for the sweep.
      writeFileSync(`${tmp}/.agent-env-fresh`, 'x');
      const sub = (c: string) =>
        c
          .replaceAll(' /tmp', ' @TMP')
          .replaceAll('/run/agentbox', run)
          .replaceAll('@TMP', tmp)
          .replaceAll("SUDO='sudo -n'", "SUDO=''");
      const backend = {
        async uploadFile(_h: CloudHandle, local: string, remote: string) {
          copyFileSync(local, sub(` ${remote}`).trim());
          chmodSync(sub(` ${remote}`).trim(), 0o644);
          if (remote.startsWith('/run/')) throw new Error('wrote, then failed');
        },
        async exec(_h: CloudHandle, cmd: string) {
          execFileSync('bash', ['-c', sub(cmd)]);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      } as unknown as CloudBackend;
      await writeCloudAgentEnvFile(backend, {} as CloudHandle, { GEMINI_API_KEY: SECRET });
      expect(readdirSync(run)).toEqual(['agent.env']);
      expect(readdirSync(tmp)).toEqual(['.agent-env-fresh']);
      expect(statSync(join(run, 'agent.env')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removeCloudAgentEnvFile deletes the file and never throws', async () => {
    const execs: string[] = [];
    await removeCloudAgentEnvFile(
      {
        async exec(_h: CloudHandle, cmd: string) {
          execs.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      } as unknown as CloudBackend,
      {} as CloudHandle,
    );
    expect(execs[0]).toContain(`rm -f ${CLOUD_AGENT_ENV_FILE}`);
    await expect(
      removeCloudAgentEnvFile(
        {
          async exec() {
            throw new Error('gone');
          },
        } as unknown as CloudBackend,
        {} as CloudHandle,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails loudly when the in-box move fails', async () => {
    const backend = {
      async uploadFile() {},
      async exec() {
        return { exitCode: 1, stdout: '', stderr: 'nope' };
      },
    } as unknown as CloudBackend;
    await expect(writeCloudAgentEnvFile(backend, {} as CloudHandle, {})).rejects.toThrow(/nope/);
  });
});

describe('buildCloudAttachInnerCommand agent env', () => {
  it("exports the agent's boxRunEnv (opencode's config + state dirs)", () => {
    const cmd = buildCloudAttachInnerCommand('opencode');
    expect(cmd).toContain('export OPENCODE_CONFIG_DIR=');
    expect(cmd).toContain('export XDG_STATE_HOME=');
  });

  it('sources the 0600 agent env file before its own exports', () => {
    const cmd = buildCloudAttachInnerCommand('opencode', ['run', 'hi']);
    const src = cmd.indexOf(`. ${CLOUD_AGENT_ENV_FILE}`);
    expect(src).toBeGreaterThan(-1);
    expect(src).toBeLessThan(cmd.indexOf('export OPENCODE_CONFIG_DIR='));
  });

  it('lets the TUI env override a run-env key', () => {
    const cmd = buildCloudAttachInnerCommand('opencode', [], { XDG_STATE_HOME: '/override' });
    expect(cmd).toContain('export XDG_STATE_HOME="/override"');
    expect(cmd.match(/export XDG_STATE_HOME=/g)).toHaveLength(1);
  });

  it('launches an unknown binary without a run-env', () => {
    expect(buildCloudAttachInnerCommand('bash')).not.toContain('export ');
  });
});

describe('buildBootstrapEnv credentialSync', () => {
  const base = {
    backend: {} as KickCloudBootstrapArgs['backend'],
    handle: {} as KickCloudBootstrapArgs['handle'],
    boxId: 'box-1',
    boxName: 'demo',
    launchDockerd: true,
  } satisfies KickCloudBootstrapArgs;

  it('exports AGENTBOX_CREDENTIAL_SYNC=0 to the daemon when sync is off', () => {
    expect(buildBootstrapEnv({ ...base, credentialSync: false }).env).toContain(
      'AGENTBOX_CREDENTIAL_SYNC=0',
    );
  });

  it('leaves it unset when sync is on or unspecified', () => {
    for (const credentialSync of [true, undefined]) {
      const { env } = buildBootstrapEnv({ ...base, credentialSync });
      expect(env.some((e) => e.startsWith('AGENTBOX_CREDENTIAL_SYNC'))).toBe(false);
    }
  });
});
