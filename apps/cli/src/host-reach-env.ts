import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import { readControlPlaneEnvMap } from './control-plane/env-file.js';

/**
 * Export what the relay daemon needs to be this machine's side of the
 * host-reach channel, before any command can spawn it.
 *
 * The daemon drains the `cp` and `tool.*` actions a control box parked for this
 * machine (see `docs/plans/box-cp-host-reach-plan.md`), which takes two values it
 * cannot get for itself: the control box's URL — which lives in layered config,
 * and no child re-reads that — and the admin bearer, which lives in
 * `control-plane.env`. Both ride `process.env` into the spawned relay, the same
 * idiom as `AGENTBOX_RELAY_PORT` / `AGENTBOX_CLI_VERSION`.
 *
 * **Exactly two keys, never the whole file.** `control-plane.env` also holds
 * `AGENTBOX_HUB_PROFILE=hetzner` and `AGENTBOX_HUB_AUTH=on` — the identity of the
 * REMOTE control box. Merging the file wholesale (which an earlier version of
 * this did) leaked those into the locally spawned hub, so this machine's own hub
 * believed it was a control box: it served its UI in password mode and, worse,
 * declared itself the broker, which switches OFF the very poller this function
 * exists to enable.
 *
 * An already-exported value always wins, and every failure is swallowed: a
 * missing control box (the common case) simply means no poller, and a broken
 * config must not stop `--help`.
 */
export async function applyHostReachEnvAtStartup(): Promise<void> {
  try {
    if (!process.env.AGENTBOX_RELAY_ADMIN_TOKEN) {
      // Path resolved HERE, not at module load: `homedir()` is read once at
      // import time by the module-level default, which pins the file for the
      // life of the process even when HOME changes under it.
      const envPath = join(homedir(), '.agentbox', 'control-plane', 'control-plane.env');
      const token = readControlPlaneEnvMap(envPath).AGENTBOX_RELAY_ADMIN_TOKEN;
      if (token) process.env.AGENTBOX_RELAY_ADMIN_TOKEN = token;
    }
    if (process.env.AGENTBOX_CONTROL_PLANE_URL) return;
    const loaded = await loadEffectiveConfig(process.cwd());
    const url = (loaded.effective.relay.controlPlaneUrl ?? '').trim().replace(/\/+$/, '');
    if (url.length > 0) process.env.AGENTBOX_CONTROL_PLANE_URL = url;
  } catch {
    /* no control box configured, or an unreadable config — no poller, no crash */
  }
}
