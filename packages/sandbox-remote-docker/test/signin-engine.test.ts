import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DockerRun } from '@agentbox/sandbox-docker';
import { dockerOnRemoteTtyCommand } from '../src/remote-docker.js';
import {
  chooseSigninDocker,
  commandOnPath,
  remoteAgentImageRef,
  removeRemoteSigninVolume,
} from '../src/signin-engine.js';

describe('chooseSigninDocker', () => {
  it('keeps local docker whenever its CLI is here, hub registered or not', () => {
    expect(chooseSigninDocker({ dockerOnPath: true, hubRegistered: false })).toBe('local');
    // A laptop that deployed a control box registers `hub` too: it must not move.
    expect(chooseSigninDocker({ dockerOnPath: true, hubRegistered: true })).toBe('local');
  });

  it("uses the hub engine only where there is no docker CLI (a control box's hub container)", () => {
    expect(chooseSigninDocker({ dockerOnPath: false, hubRegistered: true })).toBe('hub');
  });

  it('has nowhere to run with neither', () => {
    expect(chooseSigninDocker({ dockerOnPath: false, hubRegistered: false })).toBe('none');
  });
});

describe('commandOnPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-path-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'docker'), '#!/bin/sh\n');
  chmodSync(join(dir, 'docker'), 0o755);
  writeFileSync(join(dir, 'notexec'), '');
  chmodSync(join(dir, 'notexec'), 0o644);

  it('finds an executable on PATH', () => {
    expect(commandOnPath('docker', { PATH: ['/nonexistent', dir].join(delimiter) })).toBe(true);
  });

  it('ignores a missing or non-executable file and an empty PATH', () => {
    expect(commandOnPath('docker', { PATH: '/nonexistent' })).toBe(false);
    expect(commandOnPath('notexec', { PATH: dir })).toBe(false);
    expect(commandOnPath('docker', {})).toBe(false);
  });
});

describe('remoteAgentImageRef', () => {
  const sha = 'a'.repeat(64);

  it('is its own fingerprint-tagged ref, distinct from the agentless base', () => {
    const ref = remoteAgentImageRef(sha, ['claude']);
    expect(ref).toMatch(/^agentbox\/box:[0-9a-f]{16}$/);
    expect(ref).not.toBe(`agentbox/box:${sha.slice(0, 16)}`);
  });

  it('differs per agent set and per context', () => {
    expect(remoteAgentImageRef(sha, ['claude'])).not.toBe(remoteAgentImageRef(sha, ['codex']));
    expect(remoteAgentImageRef(sha, ['claude'])).not.toBe(
      remoteAgentImageRef('b'.repeat(64), ['claude']),
    );
  });
});

describe('dockerOnRemoteTtyCommand', () => {
  it('forces a remote tty and quotes every argument into one login-shell string', () => {
    const cmd = dockerOnRemoteTtyCommand(
      { host: 'host.docker.internal', user: 'root', controlPath: '/cm/x.sock' },
      ['run', '-it', '--rm', '-e', 'DISPLAY=', 'img', 'claude', 'auth', 'login', "it's"],
    );
    expect(cmd.file).toBe('ssh');
    const tt = cmd.args.indexOf('-tt');
    const dest = cmd.args.indexOf('root@host.docker.internal');
    expect(tt).toBeGreaterThan(-1);
    expect(dest).toBeGreaterThan(tt);
    expect(cmd.args).toContain('ControlPath=/cm/x.sock');
    // The remote command is the single last argument: ssh joins the rest with
    // spaces, so anything unquoted would be re-split by the remote shell.
    expect(cmd.args.length).toBe(dest + 2);
    const remote = cmd.args[dest + 1]!;
    expect(remote.startsWith('bash -lc ')).toBe(true);
    expect(remote).toContain('DISPLAY=');
    expect(remote).toContain('auth login');
  });
});

describe('removeRemoteSigninVolume', () => {
  const noSleep = { sleep: () => Promise.resolve() };

  it('removes every container on the volume (login and timed-out warm-ups) before it', async () => {
    const run = vi.fn<DockerRun>((argv) =>
      Promise.resolve({
        exitCode: 0,
        stdout: argv[0] === 'ps' ? 'c1\nc2\n' : '',
        stderr: '',
      }),
    );
    await expect(removeRemoteSigninVolume(run, 'v-signin-1', noSleep)).resolves.toBe(true);
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      ['ps', '-aq', '--filter', 'volume=v-signin-1'],
      ['rm', '-f', 'v-signin-1', 'c1', 'c2'],
      ['volume', 'rm', '-f', 'v-signin-1'],
    ]);
  });

  it('retries while the volume is still held, then gives up', async () => {
    const run = vi.fn<DockerRun>((argv) =>
      Promise.resolve(
        argv[0] === 'volume'
          ? { exitCode: 1, stdout: '', stderr: 'in use' }
          : { exitCode: 0, stdout: '', stderr: '' },
      ),
    );
    await expect(removeRemoteSigninVolume(run, 'v', { attempts: 3, ...noSleep })).resolves.toBe(
      false,
    );
    expect(run.mock.calls.filter((c) => c[0][0] === 'volume')).toHaveLength(3);
  });
});
