import { isNotAuthenticatedError } from '@agentbox/sandbox-cloud';
import type { ListedBox } from '@agentbox/sandbox-docker';
import { providerForBox } from '../provider/registry.js';

/** Per-box probe budget. A hung cloud SDK call must not stall the whole list. */
const PROBE_TIMEOUT_MS = 4000;

/** One provider whose credentials were rejected during a live-state sweep. */
export interface LiveStateAuthFailure {
  provider: string;
  /** One-line fix, e.g. 'run `aws sso login --profile x`'. */
  hint: string;
  /** How many boxes kept last-known state because of it. */
  boxCount: number;
}

/**
 * Overwrite the optimistic `state` that `listBoxes()` hardcodes to `'running'`
 * for cloud boxes (it skips the SDK round-trip — see lifecycle.ts) with a real
 * `provider.probeState()`. Docker boxes already carry a live `docker inspect`
 * state and are left untouched.
 *
 * Mutates `boxes` in place. Probes run in parallel; a probe that throws or
 * exceeds {@link PROBE_TIMEOUT_MS} leaves that box's existing state as-is so the
 * command stays responsive (a wedged SDK call, one provider's expired creds)
 * rather than blocking or blanking every cloud row. The provider resolve runs
 * INSIDE the timeout on purpose: `providerForBox` funnels through
 * `ensureCredentials`, which on a TTY can open an interactive wizard — a list
 * must never hang on a prompt.
 *
 * Returns the providers whose credentials were rejected (deduped, with the
 * fix), so the caller can print one actionable line instead of silently
 * showing stale rows.
 */
export async function applyLiveCloudStates(boxes: ListedBox[]): Promise<LiveStateAuthFailure[]> {
  const authFailures = new Map<string, { hint: string; boxCount: number }>();
  await Promise.all(
    boxes.map(async (b) => {
      if (!b.provider || b.provider === 'docker') return;
      try {
        const state = await withTimeout(
          (async () => (await providerForBox(b)).probeState(b))(),
          PROBE_TIMEOUT_MS,
        );
        if (state !== null) b.state = state;
      } catch (err) {
        // Leave b.state at the listBoxes literal — best-effort freshness. But
        // a credential rejection is worth reporting once per provider: the
        // stale row would otherwise look authoritative.
        if (isNotAuthenticatedError(err)) {
          const provider = err.provider || b.provider;
          const prev = authFailures.get(provider);
          authFailures.set(provider, {
            hint: err.hint || 'log in again',
            boxCount: (prev?.boxCount ?? 0) + 1,
          });
        }
      }
    }),
  );
  return [...authFailures.entries()].map(([provider, f]) => ({ provider, ...f }));
}

/** Resolve to the promise's value, or `null` if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof t.unref === 'function') t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
