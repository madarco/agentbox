/**
 * Persistent (always-on) boxes: which providers can host one, and the refusal
 * text for the ones that can't.
 *
 * e2b and vercel run their boxes as Firecracker microVMs with a HARD per-session
 * cap (E2B Hobby 1h, Vercel Hobby ~45m). The host keepalive can push the
 * death-time out within that cap but cannot remove it, so a box created there
 * lapses whatever `persistent` says — hence a refusal by name rather than a
 * warning.
 */

/** Providers whose session cap makes an always-on box impossible. */
export const PERSISTENT_UNSUPPORTED: Readonly<Record<string, string>> = {
  e2b: 'E2B sandboxes carry a platform session cap (1h on Hobby, 24h on Pro) that the host keepalive can extend within, never remove — the box would lapse on its own',
  vercel:
    'Vercel Sandboxes carry a platform session cap (~45m on Hobby, ~5h on Pro+) that the host keepalive can extend within, never remove — the box would lapse on its own',
};

/**
 * The refusal message for `--persistent` / `box.persistent` on `provider`, or
 * `null` when the provider can host an always-on box.
 */
export function persistentRefusal(provider: string): string | null {
  const why = PERSISTENT_UNSUPPORTED[provider];
  if (!why) return null;
  return (
    `--persistent is not supported on ${provider}: ${why}. ` +
    'Use a provider with no session cap: docker, hetzner, digitalocean, remote-docker, or daytona.'
  );
}
