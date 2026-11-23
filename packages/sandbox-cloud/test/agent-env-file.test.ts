import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import {
  CLOUD_AGENT_ENV_FILE,
  buildCloudAttachInnerCommand,
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
    expect(renderAgentEnvFile({ 'BAD;rm -rf /': 'x', OK: 'y' })).toBe("OK='y'\n");
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
