import { describe, expect, it } from 'vitest';
import { buildDockerWaitCommand, buildSudoRepairCommand } from '../src/prepare-vm.js';
import { defaultSnapshotName } from '../src/prepare.js';

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
