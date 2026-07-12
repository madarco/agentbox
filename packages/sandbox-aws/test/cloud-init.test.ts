import { describe, expect, it } from 'vitest';
import { cloudInitBoxEnv, generateBoxCloudInit, generatePrepareCloudInit } from '../src/cloud-init.js';

const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample+Key/Here agentbox';

describe('generatePrepareCloudInit', () => {
  const yaml = generatePrepareCloudInit({ sshPubkey: PUBKEY });

  it('installs the key for ROOT, not the default ubuntu user', () => {
    // install-box.sh renames the UID-1000 user (`ubuntu` on a Canonical AMI) to
    // `vscode`, and usermod -l refuses to rename an account with running
    // processes. If we logged in as `ubuntu`, our own shell would block the bake.
    expect(yaml).toContain('/root/.ssh/authorized_keys');
    expect(yaml).toContain('disable_root: false');
    expect(yaml).toContain(PUBKEY);
  });

  it('writes the key from runcmd so it survives cloud-init\'s own ssh module', () => {
    // cloud-init's disable_root handling prepends a forced-command banner to
    // root's authorized_keys during the init stage. runcmd runs last and wins.
    const runcmdAt = yaml.indexOf('runcmd:');
    expect(runcmdAt).toBeGreaterThan(-1);
    expect(yaml.indexOf('/root/.ssh/authorized_keys')).toBeGreaterThan(runcmdAt);
  });

  it('disables password auth', () => {
    expect(yaml).toContain('ssh_pwauth: false');
  });

  it('is ASCII-only', () => {
    // The sibling providers hit user-data truncation on a stray em-dash. EC2
    // base64-encodes the blob so it is less fragile, but there is no reason to
    // find out the hard way.
    expect(/^[\x20-\x7E\n]*$/.test(yaml)).toBe(true);
  });
});

describe('generateBoxCloudInit', () => {
  it('injects the per-box key for vscode and the .localhost alias', () => {
    const yaml = generateBoxCloudInit({ sshPubkey: PUBKEY, boxName: 'smoke' });
    expect(yaml).toContain('- name: vscode');
    expect(yaml).toContain(PUBKEY);
    expect(yaml).toContain('127.0.0.1 smoke.localhost');
    // Boxes boot from the baked AMI; root login stays off.
    expect(yaml).toContain('disable_root: true');
  });

  it('writes box.env only when there is something to write', () => {
    const bare = generateBoxCloudInit({ sshPubkey: PUBKEY, boxName: 'smoke' });
    expect(bare).not.toContain('/etc/agentbox/box.env');

    const withEnv = generateBoxCloudInit({
      sshPubkey: PUBKEY,
      boxName: 'smoke',
      boxEnv: { AGENTBOX_BOX_NAME: 'smoke' },
    });
    expect(withEnv).toContain('/etc/agentbox/box.env');
    expect(withEnv).toContain('AGENTBOX_BOX_NAME=smoke');
  });
});

describe('cloudInitBoxEnv', () => {
  it('keeps the AGENTBOX_* identity vars', () => {
    expect(cloudInitBoxEnv({ AGENTBOX_BOX_NAME: 'smoke', AGENTBOX_BOX_HOST: 'smoke.localhost' })).toEqual({
      AGENTBOX_BOX_NAME: 'smoke',
      AGENTBOX_BOX_HOST: 'smoke.localhost',
    });
  });

  it('strips the relay + bridge secrets', () => {
    // box.env is world-readable (0644). The relay token reaches in-box ctl via
    // the daemon's 0600 relay.env instead. DigitalOcean's naive
    // startsWith('AGENTBOX_') filter leaks all three of these — this is the bug
    // we deliberately did not inherit.
    const out = cloudInitBoxEnv({
      AGENTBOX_BOX_NAME: 'smoke',
      AGENTBOX_RELAY_URL: 'http://10.0.0.1:8787',
      AGENTBOX_RELAY_TOKEN: 'super-secret',
      AGENTBOX_BRIDGE_TOKEN: 'also-secret',
    });
    expect(out).toEqual({ AGENTBOX_BOX_NAME: 'smoke' });
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });

  it('ignores non-AGENTBOX vars entirely', () => {
    expect(cloudInitBoxEnv({ AWS_SECRET_ACCESS_KEY: 'nope', PATH: '/usr/bin' })).toEqual({});
  });
});
