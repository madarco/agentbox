// Peer-address plumbing for the loopback-gated Next routes (custody byte-read).
//
// A Next route handler only sees a Web `Request`, which carries no socket peer
// address — so the custom server (server.ts) stamps the loopback verdict onto a
// trusted header before handing the request to Next. server.ts owns the single
// node:http socket, so `req.socket.remoteAddress` there is the real peer; it
// STRIPS any client-supplied copy of this header first, so a remote caller can
// never forge "I'm loopback". The route reads {@link PEER_LOOPBACK_HEADER}: `'1'`
// means the request arrived over loopback, anything else (incl. absence) means it
// did not.
//
// Why this exists: the localhost hub binds 0.0.0.0 (Step 2 — docker boxes reach
// the embedded relay at host.docker.internal:8787), so the token profile's routes
// are LAN-reachable. Most are metadata-only or box-scoped, but a custody byte-read
// returns real credential bytes, so it must stay loopback-only on the token
// profile (see custody-auth.ts).

/** Trusted header carrying the loopback verdict from server.ts to a Next route. */
export const PEER_LOOPBACK_HEADER = 'x-agentbox-peer-loopback';

/**
 * Whether a socket peer address is loopback. Mirrors the relay's own
 * `isLoopbackAddress` (packages/relay/src/server.ts) — duplicated (not imported)
 * because @agentbox/relay pulls execa into Next's bundle. Accepts the IPv4 range,
 * IPv6 `::1`, and the IPv4-mapped-IPv6 form node reports for a v4 loopback client.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
  );
}
