import { describe, expect, it } from 'vitest';
import {
  buildDockerWaitCommand,
  buildEnvRestoreCommand,
  buildSudoRepairCommand,
} from '../src/prepare-vm.js';
import { defaultSnapshotName } from '../src/prepare.js';

describe('buildEnvRestoreCommand', () => {
  // A container inherits the image's ENV from its metadata; a linux-vm keeps the
  // rootfs and drops the metadata, so every ENV vanishes. DISPLAY=:1 above all —
  // without it the in-box browser dies with "Missing X server or $DISPLAY".
  const env = ['DISPLAY=:1', 'BROWSER=/usr/local/bin/agentbox-open', "ODD=a'b"];
  const cmd = buildEnvRestoreCommand(env);

  function decodeStaged(nth: number): string {
    const blobs = [...cmd.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]!);
    return Buffer.from(blobs[nth]!, 'base64').toString('utf8');
  }

  it('writes a profile.d script for login shells', () => {
    const profile = decodeStaged(0);
    expect(profile).toContain("export DISPLAY=':1'");
    expect(profile).toContain("export BROWSER='/usr/local/bin/agentbox-open'");
    expect(cmd).toContain('/etc/profile.d/agentbox-image-env.sh');
  });

  it('also writes /etc/environment, which profile.d does not cover', () => {
    const envFile = decodeStaged(1);
    expect(envFile).toContain('DISPLAY=:1');
    expect(cmd).toContain('tee -a /etc/environment');
  });

  it('survives a value containing a quote', () => {
    // The command is itself shipped through a shell, so the payload goes as
    // base64 rather than inline quoting — a stray quote must not break the script.
    // POSIX single-quote escaping: a' -> 'a'\''b'
    expect(decodeStaged(0)).toContain("export ODD='a'\\''b'");
  });

  it('needs root, so it runs after the sudo repair', () => {
    expect(cmd).toContain('sudo tee');
  });
});

describe('buildSudoRepairCommand', () => {
  // Converting the box container image into a VM rootfs strips setuid bits, so
  // sudo lands as 0755 and cannot escalate. There is no in-guest root to fix it
  // with (create({user:'root'}) fails to start) -- except the docker socket,
  // which the image already grants vscode.
  const cmd = buildSudoRepairCommand();

  it('restores the setuid bit and root ownership on sudo', () => {
    expect(cmd).toContain('chmod 4755 /host/usr/bin/sudo');
    expect(cmd).toContain('chown root:root /host/usr/bin/sudo');
  });

  it('borrows root from the docker daemon, since the guest has none', () => {
    expect(cmd).toContain('docker run');
    expect(cmd).toContain('--privileged');
    // Mounting / at /host is what lets an unprivileged vscode write a root-owned
    // file. Without it the container's root is useless to us.
    expect(cmd).toContain('-v /:/host');
  });

  it('reaps the helper container', () => {
    expect(cmd).toContain('--rm');
  });

  it('adds the hostname to /etc/hosts, idempotently', () => {
    // Otherwise every sudo call warns "unable to resolve host <name>" and eats a
    // DNS timeout. Re-running the bake must not append the entry twice.
    expect(cmd).toContain('/host/etc/hosts');
    expect(cmd).toContain('grep -q');
  });
});

describe('buildDockerWaitCommand', () => {
  it('polls for dockerd rather than assuming it is up', () => {
    // dockerd starts at boot but not instantly, and the sudo repair depends on it.
    const cmd = buildDockerWaitCommand();
    expect(cmd).toContain('docker info');
    expect(cmd).toMatch(/seq 1 \d+/);
    expect(cmd).toContain('exit 1');
  });
});

describe('defaultSnapshotName — class suffix', () => {
  const SHA = 'f'.repeat(64);

  it('suffixes -vm so a VM and container bake of the same context cannot collide', () => {
    expect(defaultSnapshotName(SHA, undefined, 'linux-vm')).toBe('agentbox-base-ffffffffffff-vm');
  });

  it('leaves container names unsuffixed, so existing snapshot names keep resolving', () => {
    expect(defaultSnapshotName(SHA, undefined, 'container')).toBe('agentbox-base-ffffffffffff');
    expect(defaultSnapshotName(SHA)).toBe('agentbox-base-ffffffffffff');
  });

  it('composes with the size suffix', () => {
    expect(defaultSnapshotName(SHA, '4-8-20', 'linux-vm')).toBe(
      'agentbox-base-ffffffffffff-4-8-20-vm',
    );
  });
});
