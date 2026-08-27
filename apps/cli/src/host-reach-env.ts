import { loadEffectiveConfig } from '@agentbox/config';
import { loadControlPlaneEnv } from './control-plane/env-file.js';

/**
 * Export what the relay daemon needs to be this machine's side of the
 * host-reach channel, before any command can spawn it.
 *
 * The daemon drains `cp` actions a control box parked for this machine (see
 * `docs/plans/box-cp-host-reach-plan.md`), which takes two values it cannot get
 * for itself: the control box's URL — which lives in layered config, and no
 * child re-reads that — and the admin bearer, which lives in
 * `control-plane.env`. Both ride `process.env` into the spawned relay, the same
 * idiom as `AGENTBOX_RELAY_PORT` / `AGENTBOX_CLI_VERSION`.
 *
 * An already-exported value always wins, and every failure is swallowed: a
 * missing control box (the common case) simply means no poller, and a broken
 * config must not stop `--help`.
 */
export async function applyHostReachEnvAtStartup(): Promise<void> {
  try {
    // Brings AGENTBOX_RELAY_ADMIN_TOKEN (and the App creds) in per-key without
    // overriding anything the shell already set.
    loadControlPlaneEnv();
    if (process.env.AGENTBOX_CONTROL_PLANE_URL) return;
    const loaded = await loadEffectiveConfig(process.cwd());
    const url = (loaded.effective.relay.controlPlaneUrl ?? '').trim().replace(/\/+$/, '');
    if (url.length > 0) process.env.AGENTBOX_CONTROL_PLANE_URL = url;
  } catch {
    /* no control box configured, or an unreadable config — no poller, no crash */
  }
}
