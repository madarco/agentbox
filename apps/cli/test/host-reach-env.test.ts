import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHostReachEnvAtStartup } from '../src/host-reach-env.js';

/**
 * What this exports lands in EVERY spawned daemon, including this machine's own
 * hub. Taking the whole `control-plane.env` made that hub inherit the remote
 * control box's identity (`AGENTBOX_HUB_PROFILE=hetzner`, `AGENTBOX_HUB_AUTH=on`)
 * — so it served its UI in password mode and declared itself the broker, which
 * disables the poller this function exists to enable. Seen on a live machine.
 */

const KEEP = ['HOME', 'AGENTBOX_RELAY_ADMIN_TOKEN', 'AGENTBOX_CONTROL_PLANE_URL', 'AGENTBOX_HUB_PROFILE', 'AGENTBOX_HUB_AUTH'] as const;
const saved = new Map<string, string | undefined>();
let home: string;

beforeEach(async () => {
  for (const k of KEEP) saved.set(k, process.env[k]);
  home = await mkdtemp(join(tmpdir(), 'agentbox-hre-'));
  process.env.HOME = home;
  for (const k of KEEP.slice(1)) delete process.env[k];
  await mkdir(join(home, '.agentbox', 'control-plane'), { recursive: true });
  await writeFile(
    join(home, '.agentbox', 'control-plane', 'control-plane.env'),
    [
      'AGENTBOX_RELAY_ADMIN_TOKEN=admin-secret',
      'AGENTBOX_HUB_PROFILE=hetzner',
      'AGENTBOX_HUB_AUTH=on',
      'AGENTBOX_HUB_API_KEY=key',
      'GH_TOKEN=ghp_x',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(home, '.agentbox', 'config.yaml'),
    'schema: 1\nrelay:\n  controlPlaneUrl: https://cp.example/\n',
    'utf8',
  );
});

afterEach(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

describe('applyHostReachEnvAtStartup', () => {
  it('exports the admin token from the control-plane file', async () => {
    // Only the token is asserted: `@agentbox/config` resolves HOME at import
    // time, so the URL half reads this developer's real config and is not
    // something a unit test can pin without isolating the whole loader.
    await applyHostReachEnvAtStartup();
    expect(process.env.AGENTBOX_RELAY_ADMIN_TOKEN).toBe('admin-secret');
  });

  it('never exports the control box IDENTITY into this machine', async () => {
    await applyHostReachEnvAtStartup();
    // The local hub inherits process.env; these would make it believe it is the
    // control box — password-mode UI, and no host-action poller.
    expect(process.env.AGENTBOX_HUB_PROFILE).toBeUndefined();
    expect(process.env.AGENTBOX_HUB_AUTH).toBeUndefined();
  });

  it('leaves an explicitly exported token alone', async () => {
    process.env.AGENTBOX_RELAY_ADMIN_TOKEN = 'from-the-shell';
    await applyHostReachEnvAtStartup();
    expect(process.env.AGENTBOX_RELAY_ADMIN_TOKEN).toBe('from-the-shell');
  });
});
