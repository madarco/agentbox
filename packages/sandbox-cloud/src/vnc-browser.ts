import type { BoxRecord, Provider } from '@agentbox/core';
import { withServiceSignIn } from '@agentbox/sandbox-core';
import { desktopOpenCommand, readBoxStatus } from '@agentbox/sandbox-docker';

export interface CloudVncBrowserResult {
  /** True when the in-box browser was pointed at the web app. */
  opened: boolean;
  /** URL that was opened, when `opened`. */
  target?: string;
  /** Why nothing was opened (`no web service`, exec failure, resolve error). */
  reason?: string;
}

/**
 * Cloud counterpart of sandbox-docker's `ensureBoxBrowserShowingApp`: point the
 * in-box browser at the box's public web preview URL so the VNC desktop shows
 * the app instead of a blank X screen. The box can reach its own preview domain
 * (verified on vercel), so host and box load one origin. No-op when the box
 * declares no exposed web service. Goes through the same desktop launcher the
 * docker path uses, so a cloud box's first launch (a Chromium download, worse
 * over a cold cloud disk) shows a progress window on the desktop instead of
 * holding this exec open for a minute. Best-effort by contract — callers surface
 * `reason` as a warning and never fail the open-VNC flow on it.
 */
export async function openWebAppOnVncScreen(
  box: BoxRecord,
  provider: Provider,
): Promise<CloudVncBrowserResult> {
  const persisted = await readBoxStatus(box);
  const exposed = persisted?.services.find((s) => s.expose);
  if (!exposed) return { opened: false, reason: 'no web service' };
  try {
    // Sign-in fragment LAST: `inBoxReachable` rebuilds the URL from the
    // service's own port, which would drop a fragment resolved before it.
    const target = await withServiceSignIn(
      provider,
      box,
      inBoxReachable(await provider.resolveUrl(box, { kind: 'web' }), exposed),
    );
    const br = await provider.exec(box, ['bash', '-lc', desktopOpenCommand(target)], {
      user: 'vscode',
    });
    if (br.exitCode === 0) return { opened: true, target };
    return {
      opened: false,
      reason: br.stderr.trim() || br.stdout.trim() || `exit ${String(br.exitCode)}`,
    };
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The URL to hand the browser INSIDE the box, given the one the host would use.
 *
 * A `<box>.localhost` URL works in both places: the in-box portless mirror
 * serves the same name. A literal `127.0.0.1:<port>` does not — that port is an
 * `ssh -L` forward living on the HOST, and inside the box it is nothing. The
 * box reaches its own service most directly anyway, so fall back to the port the
 * service actually listens on.
 *
 * Hit by a box whose agent refuses proxied requests (no portless web alias, so
 * the resolved URL is the raw tunnel) and equally by one where the user turned
 * portless off.
 */
function inBoxReachable(hostUrl: string, exposed: { expose?: { port: number } }): string {
  const port = exposed.expose?.port;
  if (port === undefined) return hostUrl;
  let hostname: string;
  try {
    hostname = new URL(hostUrl).hostname;
  } catch {
    return hostUrl;
  }
  const isHostLoopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
  return isHostLoopback ? `http://localhost:${String(port)}` : hostUrl;
}
