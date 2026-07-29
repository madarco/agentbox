/**
 * Opportunistic by-name adoption of a control-box box.
 *
 * With a control box configured the PC is a thin client, so a box the user
 * refers to by name may exist only in the control box's registry (web-UI create
 * / `--via-hub`). Rather than teaching every box-arg command about the control
 * box, `resolveBoxOrExit` calls this on a local miss: one bounded round-trip
 * that resolves the ref server-side (`GET /api/v1/boxes?ref=`) and materializes
 * the local record, after which the normal resolve path finds it and the command
 * proceeds as if the box had been created here.
 *
 * Everything here is best-effort — no control box, no network, or an unknown
 * ref all return null and the caller falls back to its usual "no such box"
 * error. It must never turn an offline PC into a hang, hence the hard timeout.
 *
 * Only a genuinely REMOTE hub (a configured control box, or a `hub expose`-d
 * loopback) is asked. A plain local hub is skipped: its boxes are already in
 * this machine's `state.json` and were found by the local resolver before we got
 * here, so there is nothing to adopt — and skipping it means a plain-PC typo
 * never round-trips or auto-starts a daemon.
 */
import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';

/**
 * The adopted box, `'unreachable'` when the control box couldn't be asked (it's
 * down, slow, or we have no token for it), or null when there was nothing to ask
 * — no remote hub configured, or it answered and doesn't know the ref.
 *
 * The distinction matters to the shift path: "no such box" is a fact it can act
 * on, while "couldn't ask" means any guess it makes might target the wrong box.
 */
export type AutoAdoptResult = BoxRecord | 'unreachable' | null;

/** Bound on the whole adopt round-trip. A miss must not stall the command. */
const ADOPT_TIMEOUT_MS = 4000;

/**
 * Bound on the "is the control box even up?" probe, which is deliberately much
 * tighter than the adopt budget: a TCP connect to a live host takes
 * milliseconds, so anything slower means it's effectively down. This is what a
 * DOWN control box costs, and `resolveBoxOrShift` runs it on tokens that are
 * usually a shell command (`agentbox shell npm run dev`) — spending the full
 * adopt budget there would make a routine command feel broken.
 */
const REACHABLE_PROBE_MS = 1500;

/**
 * Try to adopt `ref` from the configured control box. Returns the freshly
 * recorded box, or null when there is no remote hub, it's unreachable, or it
 * doesn't know the ref.
 *
 * Imports its dependencies lazily: this runs on every by-name miss, including
 * on hosts with no control box at all, and the control-plane clients pull in
 * config + relay code that a plain `agentbox shell typo` shouldn't pay for.
 */
export async function tryAutoAdopt(ref: string, cwd: string): Promise<AutoAdoptResult> {
  try {
    // Which hub owns cloud boxes? A genuinely remote hub only — never the plain
    // local hub (see the module header). `resolveHubTarget` reports `remote` for
    // both a configured control box and a `hub expose`-d loopback, and `local`
    // for a plain local hub.
    const { resolveHubTarget } = await import('../commands/hub.js');
    const target = await resolveHubTarget();
    if (target.mode !== 'remote') return null;
    // A remote hub is configured but we hold no API key for it — we could not
    // ask. Returning null here would tell the shift path "definitely not a hub
    // box", which is how `agentbox claude <hub-box>` ends up in the wrong box.
    if (!target.token) return 'unreachable';

    const [{ adoptHubBox }, { HubApiClient }, { deadlineFetch, hostReachable }] = await Promise.all(
      [import('./hub-adopt.js'), import('./hub-api-client.js'), import('@agentbox/sandbox-cloud')],
    );

    // ONE budget for the whole attempt, spent down by each step — not a fresh
    // timeout per step, which would let the worst case run to a multiple of the
    // documented ceiling.
    const deadline = Date.now() + ADOPT_TIMEOUT_MS;
    const remaining = (): number => deadline - Date.now();

    // A fetch to an unreachable host can't be cancelled and would hold the
    // process open past the deadline. Probe with a socket we own first.
    if (!(await hostReachable(target.url, Math.min(REACHABLE_PROBE_MS, remaining())))) {
      return 'unreachable';
    }
    if (remaining() <= 0) return 'unreachable';

    // One signal bounds the whole adoption. Aborting — rather than racing and
    // walking away — also means we never abandon an adoption that then completes
    // and writes state.json behind our back.
    const signal = AbortSignal.timeout(remaining());
    const client = new HubApiClient({
      url: target.url,
      apiKey: target.token,
      fetchImpl: deadlineFetch(signal),
    });

    const matches = await client.resolveBox(ref);
    // The control box answered and doesn't know the ref — a definitive miss.
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // An ambiguous prefix on the hub. The caller writes state and then drives
      // the box, so guessing is worse than stopping — surface the chooser, the
      // same way `resolveBoxOrExit` does for a local ambiguous ref.
      log.error(`'${ref}' matches multiple boxes on the control box — pick one:`);
      for (const b of matches) {
        process.stderr.write(`  ${b.name ?? b.id}   (id ${b.id})\n`);
      }
      log.info('retry with a longer id prefix, the full name, or the sandbox id');
      process.exit(2);
    }

    // SSH keys still come from custody (an admin-token surface — Step 10 moves
    // it onto /api/v1). Best-effort: no admin token → adopt the record without
    // keys (fine for SDK providers; flagged for SSH ones).
    const { resolveCustodyTarget } = await import('../commands/control-plane.js');
    const { CustodyClient } = await import('./custody-client.js');
    const custodyTarget = await resolveCustodyTarget(undefined, { quiet: true });
    const custody = custodyTarget
      ? new CustodyClient({ ...custodyTarget, fetchImpl: deadlineFetch(signal) })
      : undefined;

    const res = await adoptHubBox({
      box: matches[0]!,
      custody,
      controlPlaneUrl: target.url,
      cwd,
    });
    return res.record;
  } catch {
    // A network failure, an expired budget, or a bad token mean we never got an
    // answer — say so, rather than let a caller read it as "not a box". (A
    // definitive "no such box" is the empty-match case above, not an exception.)
    return 'unreachable';
  }
}
