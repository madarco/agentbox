import type { ListedBox } from '@agentbox/sandbox-docker';
import { providerForBox } from '../provider/registry.js';

/** Per-box probe budget. A hung cloud SDK call must not stall the whole list. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Overwrite the optimistic `state` that `listBoxes()` hardcodes to `'running'`
 * for cloud boxes (it skips the SDK round-trip — see lifecycle.ts) with a real
 * `provider.probeState()`. Docker boxes already carry a live `docker inspect`
 * state and are left untouched.
 *
 * Mutates `boxes` in place. Probes run in parallel; a probe that throws or
 * exceeds {@link PROBE_TIMEOUT_MS} leaves that box's existing state as-is so the
 * command stays responsive (e.g. missing/expired cloud creds, a wedged SDK call)
 * rather than blocking or blanking every cloud row.
 */
export async function applyLiveCloudStates(boxes: ListedBox[]): Promise<void> {
  await Promise.all(
    boxes.map(async (b) => {
      if (!b.provider || b.provider === 'docker') return;
      try {
        const provider = await providerForBox(b);
        const state = await withTimeout(provider.probeState(b), PROBE_TIMEOUT_MS);
        if (state !== null) b.state = state;
      } catch {
        // Leave b.state at the listBoxes literal — best-effort freshness.
      }
    }),
  );
}

/** Resolve to the promise's value, or `null` if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof t.unref === 'function') t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}
