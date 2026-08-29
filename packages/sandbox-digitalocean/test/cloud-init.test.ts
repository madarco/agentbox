import { describe, expect, it } from 'vitest';
import {
  controlPlaneCloudInit,
  generateBoxCloudInit,
  generateDerivedPrepareCloudInit,
  generatePrepareCloudInit,
} from '../src/cloud-init.js';
import { cloudInitBoxEnv } from '../src/backend.js';

const FAKE_PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILongTextForKey agentbox/test';

describe('cloudInitBoxEnv', () => {
  it('keeps AGENTBOX_* identity/portless vars', () => {
    const out = cloudInitBoxEnv({
      AGENTBOX_BOX_ID: 'id',
      AGENTBOX_BOX_NAME: 'name',
      AGENTBOX_BOX_HOST: 'name.localhost',
      AGENTBOX_WEB_PROXY_PORT: '8080',
    });
    expect(out).toEqual({
      AGENTBOX_BOX_ID: 'id',
      AGENTBOX_BOX_NAME: 'name',
      AGENTBOX_BOX_HOST: 'name.localhost',
      AGENTBOX_WEB_PROXY_PORT: '8080',
    });
  });

  it('strips relay/bridge secrets so they never reach the 0644 box.env', () => {
    const out = cloudInitBoxEnv({
      AGENTBOX_BOX_ID: 'id',
      AGENTBOX_RELAY_URL: 'http://127.0.0.1:8788',
      AGENTBOX_RELAY_TOKEN: 'secret-relay',
      AGENTBOX_BRIDGE_TOKEN: 'secret-bridge',
    });
    expect(out).toEqual({ AGENTBOX_BOX_ID: 'id' });
    expect(out).not.toHaveProperty('AGENTBOX_RELAY_TOKEN');
    expect(out).not.toHaveProperty('AGENTBOX_BRIDGE_TOKEN');
  });

  it('drops non-AGENTBOX keys and undefined values', () => {
    expect(cloudInitBoxEnv({ PATH: '/usr/bin', AGENTBOX_X: undefined })).toEqual({});
    expect(cloudInitBoxEnv()).toEqual({});
  });
});

describe('generatePrepareCloudInit', () => {
  it('emits a valid `#cloud-config` doc with the pubkey for root (top-level form)', () => {
    const yaml = generatePrepareCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml.startsWith('#cloud-config')).toBe(true);
    // Top-level `ssh_authorized_keys` (default user = root on DO) — the
    // `users:`-block form does NOT inject a key for root on DO Ubuntu 24.04.
    expect(yaml).toContain('ssh_authorized_keys:');
    expect(yaml).not.toContain('name: root');
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
    expect(yaml).toContain('ssh_pwauth: false');
  });

  it('disables first-login password expiry (DigitalOcean Ubuntu would block key-only ssh otherwise)', () => {
    const yaml = generatePrepareCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).toContain('chpasswd:');
    expect(yaml).toContain('expire: false');
    // The runcmd belt-and-braces resets root's last-change date to TODAY —
    // `passwd -d` + `chage -E/-I/-M` alone do NOT clear DO's force-expired flag.
    expect(yaml).toContain('[ passwd, -d, root ]');
    expect(yaml).toContain('chage -d $(date +%Y-%m-%d)');
  });

  it('trims surrounding whitespace from the pubkey', () => {
    const yaml = generatePrepareCloudInit({ sshPubkey: `   ${FAKE_PUBKEY}\n` });
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
  });
});

describe('generateBoxCloudInit', () => {
  it('injects the pubkey for vscode (not root) and writes the localhost alias', () => {
    const yaml = generateBoxCloudInit({
      sshPubkey: FAKE_PUBKEY,
      boxName: 'mybox',
    });
    expect(yaml).toContain('name: vscode');
    expect(yaml).toContain('disable_root: true');
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
    // /etc/hosts append carrying the symmetric URL target.
    expect(yaml).toContain('path: /etc/hosts');
    expect(yaml).toContain('127.0.0.1 mybox.localhost');
    // Same expiry-disable guard as the prepare cloud-init.
    expect(yaml).toContain('chpasswd:');
    expect(yaml).toContain('expire: false');
  });

  it('emits box.env when provided', () => {
    const yaml = generateBoxCloudInit({
      sshPubkey: FAKE_PUBKEY,
      boxName: 'mybox',
      boxEnv: { AGENTBOX_BOX_ID: 'abc123', AGENTBOX_BRIDGE_TOKEN: 'sec' },
    });
    expect(yaml).toContain('path: /etc/agentbox/box.env');
    expect(yaml).toContain('AGENTBOX_BOX_ID=abc123');
    expect(yaml).toContain('AGENTBOX_BRIDGE_TOKEN=sec');
  });

  it('omits the box.env block when boxEnv is empty / undefined', () => {
    const yaml = generateBoxCloudInit({ sshPubkey: FAKE_PUBKEY, boxName: 'mybox' });
    expect(yaml).not.toContain('path: /etc/agentbox/box.env');
  });
});

describe('controlPlaneCloudInit', () => {
  it('logs in as root, installs Docker + git, and injects the pubkey (top-level form)', () => {
    const yaml = controlPlaneCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml.startsWith('#cloud-config')).toBe(true);
    expect(yaml).toContain('disable_root: false');
    expect(yaml).toContain('ssh_authorized_keys:');
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
    expect(yaml).toContain('get.docker.com');
    expect(yaml).toContain('install -y git');
    // Same DO expiry-disable guard as the prepare/box cloud-inits.
    expect(yaml).toContain('[ passwd, -d, root ]');
  });

  it('omits the repo clone in package mode', () => {
    const yaml = controlPlaneCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).not.toContain('/opt/agentbox');
    expect(yaml).not.toContain('git clone');
  });

  it('clones the repo at the given ref in source mode', () => {
    const yaml = controlPlaneCloudInit({
      sshPubkey: FAKE_PUBKEY,
      repo: { url: 'https://github.com/madarco/agentbox', ref: 'feat/remote-hub-improvements' },
    });
    expect(yaml).toContain('git clone');
    expect(yaml).toContain('/opt/agentbox');
    expect(yaml).toContain("'feat/remote-hub-improvements'");
    expect(yaml).toContain("'https://github.com/madarco/agentbox'");
  });
});

describe('generateDerivedPrepareCloudInit', () => {
  it('injects the key for vscode, not root -- the base snapshot refuses root ssh', () => {
    // install-box.sh bakes `PermitRootLogin no` + `AllowUsers vscode` into the
    // base. A root key here is accepted by cloud-init and then refused by sshd,
    // which surfaces only as an unexplained waitForSsh timeout.
    const yaml = generateDerivedPrepareCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).toContain('disable_root: true');
    expect(yaml).toContain('  - name: vscode');
    expect(yaml).toContain(FAKE_PUBKEY);
    // No top-level root key block (the shape generatePrepareCloudInit uses).
    expect(yaml).not.toMatch(/^ssh_authorized_keys:/m);
  });

  it('grants vscode passwordless sudo -- the install steps escalate', () => {
    const yaml = generateDerivedPrepareCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).toContain('sudo: ALL=(ALL) NOPASSWD:ALL');
  });

  it('emits ASCII only', () => {
    // DigitalOcean truncates user-data at the first non-ASCII byte: one em-dash
    // silently drops the whole document, no key is injected, and ssh fails with
    // "Permission denied (publickey)".
    const yaml = generateDerivedPrepareCloudInit({ sshPubkey: FAKE_PUBKEY });
    // eslint-disable-next-line no-control-regex
    expect(yaml).toMatch(/^[\x00-\x7F]*$/);
  });

  it('trims a pubkey with surrounding whitespace', () => {
    const yaml = generateDerivedPrepareCloudInit({ sshPubkey: `   ${FAKE_PUBKEY}\n` });
    expect(yaml).toContain(`      - "${FAKE_PUBKEY}"`);
  });
});
