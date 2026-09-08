/**
 * What the **Open web** button should do for one box.
 *
 * Pure, and separate from the card, because the two ways of getting this wrong
 * are both invisible in a screenshot and both were shipped once:
 *
 *  - keying off the UI `status`, which maps a still-running box whose AGENT
 *    errored to `'error'` — and that is exactly when someone opens the
 *    dashboard to find out what happened;
 *  - assuming `webUrl` is absent for a box that is not running. It is not: the
 *    listing fills it from the box's persisted endpoints whatever the runtime
 *    state, so a paused box kept an enabled button pointing at a dead URL, and
 *    the "Box is paused — resume to access" branch beside it was unreachable.
 *
 * So: the raw provider `state` decides whether the box can serve anything, and
 * `webUrl` only decides whether it has a web service at all.
 */

export interface WebOpenBox {
  id: string;
  /** Recorded web URL — presence means "has a web service", not "reachable". */
  webUrl?: string | null;
  /** Raw provider state. Absent on a hosted plane and on synthetic job boxes. */
  state?: 'running' | 'paused' | 'stopped' | 'missing' | 'destroyed';
  /** UI-normalized status; the fallback when the hub sent no raw state. */
  status?: string;
}

export interface WebOpenTarget {
  /** Where the button links, or null when it should be disabled. */
  href: string | null;
  /** Why it is disabled; null when it is not. */
  reason: string | null;
}

/**
 * The link is the hub's own page route, never the recorded URL: it resolves
 * live at click time and adds a service agent's sign-in token, and an `<a href>`
 * navigates synchronously where a fetch-then-`window.open` would lose user
 * activation and be popup-blocked.
 */
export function webOpenTarget(box: WebOpenBox): WebOpenTarget {
  // `state` when the hub sent it; `status` is the fallback for a hosted plane,
  // where an agent error cannot be told apart from a dead box anyway.
  const running = box.state ? box.state === 'running' : box.status === 'running';
  if (!box.webUrl) {
    return { href: null, reason: notRunningReason(box) ?? 'No web service exposed' };
  }
  if (!running) {
    return { href: null, reason: notRunningReason(box) ?? 'Box is not running' };
  }
  return { href: `/boxes/${encodeURIComponent(box.id)}/web`, reason: null };
}

function notRunningReason(box: WebOpenBox): string | null {
  const state = box.state ?? box.status;
  if (state === 'paused') return 'Box is paused — resume to access';
  if (state === 'stopped') return 'Box is stopped — start to access';
  if (state === 'missing') return 'Box has no sandbox left';
  return null;
}
