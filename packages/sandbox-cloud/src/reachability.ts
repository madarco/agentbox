/**
 * "Is the control box even up?" — the probe every best-effort custody call must
 * make before reaching for `fetch`.
 *
 * This is not an optimization. Node's `fetch` cannot be made to give up on a TCP
 * connect: `AbortSignal` rejects the promise, but undici holds the connecting
 * socket until its own ~10s `connectTimeout`, which keeps the CLI's event loop
 * (and the user's shell) alive long after the command has printed. There is no
 * public API to shorten it. A socket we open ourselves, we can destroy — so we
 * probe first and skip the fetch entirely when the host is down.
 *
 * Lives here, not in the CLI, so the provider packages (`prepare`'s bake sync,
 * the create-time seed push) share the one implementation with the CLI's `ls`,
 * auto-adopt, and `recover`.
 */
import { connect } from 'node:net';

/** A live host answers a TCP connect in milliseconds; slower means "down". */
export const DEFAULT_REACHABLE_PROBE_MS = 1500;

/**
 * Whether `url`'s host accepts a TCP connection within `ms`. The socket is
 * always destroyed, so a down host leaves nothing holding the event loop.
 */
export async function hostReachable(
  url: string,
  ms: number = DEFAULT_REACHABLE_PROBE_MS,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: parsed.hostname, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Wrap fetch so every request it makes shares one deadline `signal`. */
export function deadlineFetch(signal: AbortSignal, impl: typeof fetch = fetch): typeof fetch {
  return ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    impl(url, { ...init, signal })) as typeof fetch;
}
