import type { BoxRecord } from '@agentbox/core';

/**
 * Make sure this machine is draining the host actions its control box parks for
 * it, whenever the user starts working with a control-plane box.
 *
 * The drainer lives in the relay daemon, and the paths that only ever touch a
 * hub box — `create --via-hub`, adoption, attaching to a box created from the
 * web UI — never brought one up: every existing `ensureRelay()` call sits on a
 * *local* create/start. So the one workflow that needs the channel most was the
 * one guaranteed not to have it, and an in-box `cp` would fall back to the hub's
 * cache (or fail) while the user sat right there at the machine holding the file.
 *
 * Best-effort by construction: a box with no control box does nothing, and a
 * relay that won't start is not worth failing an attach over — the copy degrades
 * to the cache and says so.
 */
export async function ensureHostReachDrainer(box: Pick<BoxRecord, 'provider' | 'cloud'>): Promise<void> {
  try {
    if ((box.provider ?? 'docker') === 'docker') return;
    if (!box.cloud?.controlPlaneUrl) return;
    const { ensureRelay } = await import('@agentbox/sandbox-docker');
    await ensureRelay();
  } catch {
    /* best-effort: the copy path reports its own degradation */
  }
}
