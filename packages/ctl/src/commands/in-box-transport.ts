/**
 * Pure selection of the in-box relay transport from the box's env. Extracted
 * from the daemon so it's unit-testable.
 *
 * Three shapes:
 * - cloud + `AGENTBOX_CONTROL_PLANE_URL` → forwarder to the hosted control plane
 *   (the box's /rpc — incl. git.lease-token — must reach the plane's direct
 *   handler, which a `mode:'box'` /bridge relay never does).
 * - cloud, no control-plane URL → a `mode:'box'` relay buffering to /bridge for
 *   the host CloudBoxPoller (classic cloud).
 * - docker → forwarder to the host relay at `host.docker.internal` (default).
 */
export type InBoxTransport =
  | { kind: 'forwarder'; upstream: string }
  | { kind: 'box' };

export function selectInBoxTransport(env: Record<string, string | undefined>): InBoxTransport {
  const controlPlaneUrl = env.AGENTBOX_CONTROL_PLANE_URL;
  if (env.AGENTBOX_BOX_KIND === 'cloud') {
    return controlPlaneUrl && controlPlaneUrl.length > 0
      ? { kind: 'forwarder', upstream: controlPlaneUrl }
      : { kind: 'box' };
  }
  return {
    kind: 'forwarder',
    upstream: env.AGENTBOX_HOST_RELAY_URL ?? 'http://host.docker.internal:8787',
  };
}
