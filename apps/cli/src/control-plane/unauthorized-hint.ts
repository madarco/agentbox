/**
 * What to tell the user when a hub answers 401 to this computer's credential.
 *
 * Against a remote hub that almost always means this computer was revoked on the
 * hub's Devices page, or never enrolled — the same advice the relay's host-reach
 * poller gives when it stops. A local hub's 401 is a stale per-machine token.
 */
export function hubUnauthorizedHint(hubUrl: string | undefined, mode: 'local' | 'remote'): string {
  if (mode === 'local') {
    return 'The local hub rejected its token. Restart it with `agentbox hub restart`.';
  }
  const url = (hubUrl ?? '').replace(/\/+$/, '');
  const where = url ? ` at ${url}` : '';
  return (
    `The hub${where} refused this computer's credential: it was removed from the hub, or never signed in. ` +
    `Run \`agentbox hub login${url ? ` ${url}` : ''}\` to enroll it again (or \`agentbox hub logout\` to forget the old token).`
  );
}
