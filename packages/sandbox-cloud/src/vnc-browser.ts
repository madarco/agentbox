import type { BoxRecord, Provider } from '@agentbox/core';
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
  const hasWebService = persisted?.services.some((s) => s.expose) ?? false;
  if (!hasWebService) return { opened: false, reason: 'no web service' };
  try {
    const target = await provider.resolveUrl(box, { kind: 'web' });
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
