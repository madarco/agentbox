import type { BoxRecord } from '@agentbox/core';

/**
 * Tell running boxes that this machine's tool grants changed.
 *
 * The box used to ask, once a minute, because "the RPC is the one channel every
 * provider already has". But `Provider.exec` is a required interface method, so
 * the host can just say it — instantly, once, instead of every box asking
 * forever. On a control box each of those asks was a WAN round trip per box per
 * minute.
 *
 * Best-effort by design, and bounded: a box that is paused, unreachable, or slow
 * to answer is not an error the user needs to act on — its daemon reconciles at
 * startup, which is exactly the case a push cannot cover. What the user does get
 * is an honest report of which boxes took the change, so "why is my tool missing
 * in that box?" is answerable without guessing.
 */

/** Per-box ceiling. A push is a convenience; it must not hold up the command. */
const PUSH_TIMEOUT_MS = 8_000;

export interface ToolGrantPushResult {
  relinked: string[];
  /** Boxes that were running but did not take the change, with the reason. */
  failed: { name: string; reason: string }[];
}

/**
 * Push to every running box that the grant applies to: the whole fleet for a
 * global grant, this project's boxes otherwise.
 *
 * `projectRoot` is matched against the box's recorded `projectRoot`, the same
 * field `agentbox ls` scopes by.
 */
export async function pushToolGrantChange(opts: {
  global: boolean;
  projectRoot: string;
}): Promise<ToolGrantPushResult> {
  const out: ToolGrantPushResult = { relinked: [], failed: [] };
  try {
    const [{ readState }, { providerForBox }] = await Promise.all([
      import('@agentbox/sandbox-docker'),
      import('../provider/registry.js'),
    ]);
    const state = await readState();
    const targets = state.boxes.filter(
      (b) =>
        opts.global || b.projectRoot === opts.projectRoot || b.workspacePath === opts.projectRoot,
    );
    if (targets.length === 0) return out;

    await Promise.all(
      targets.map(async (box: BoxRecord) => {
        try {
          const provider = await providerForBox(box);
          // A stopped or paused box is skipped silently rather than started:
          // waking a box to hand it a symlink would be a surprising side effect
          // of `tools add`, and its daemon reconciles on the way up anyway.
          const state = await provider.probeState(box);
          if (state !== 'running') return;
          // Bounded here rather than through `ExecOptions`, which carries no
          // timeout — adding one would change the published provider SDK's
          // surface for a convenience call. Losing the race only means we stop
          // waiting; the relink itself is idempotent and harmless if it lands
          // a moment later.
          const res = await withTimeout(
            provider.exec(box, ['agentbox-ctl', 'tool', 'relink']),
            PUSH_TIMEOUT_MS,
          );
          if (res.exitCode === 0) out.relinked.push(box.name);
          else {
            out.failed.push({
              name: box.name,
              reason: (res.stderr || res.stdout || `exit ${String(res.exitCode)}`)
                .trim()
                .slice(0, 200),
            });
          }
        } catch (err) {
          out.failed.push({
            name: box.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  } catch {
    /* no state file, no provider — nothing running to tell */
  }
  return out;
}

function withTimeout<T extends { exitCode: number; stdout: string; stderr: string }>(
  work: Promise<T>,
  ms: number,
): Promise<T | { exitCode: number; stdout: string; stderr: string }> {
  // The exec cannot be cancelled (the Provider interface has no handle for it),
  // so the loser of this race is swallowed rather than left to surface later as
  // an unhandled rejection long after the command has printed its result.
  const settled = work.catch((err: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }));
  return Promise.race([
    settled,
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ exitCode: 124, stdout: '', stderr: `no answer within ${String(ms)}ms` }),
        ms,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * A box built before `tool relink` existed. Its ctl still polls for grants, so
 * it is not stale — it just takes up to a minute. Worth distinguishing: "could
 * not reach it" reads like breakage, and the fix (nothing) is different.
 */
function predatesRelink(reason: string): boolean {
  return /unknown command '?relink/i.test(reason);
}

/** One line for the CLI, or null when there was nothing running to tell. */
export function describeToolGrantPush(result: ToolGrantPushResult): string | null {
  const parts: string[] = [];
  if (result.relinked.length > 0) {
    parts.push(`applied in ${result.relinked.join(', ')}`);
  }
  const older = result.failed.filter((f) => predatesRelink(f.reason));
  const unreachable = result.failed.filter((f) => !predatesRelink(f.reason));
  if (older.length > 0) {
    parts.push(
      `${older.map((f) => f.name).join(', ')} predates this AgentBox and still polls — ` +
        'it picks the change up within a minute',
    );
  }
  if (unreachable.length > 0) {
    // Named, not swallowed: this is the box where the tool will be missing.
    parts.push(
      `could not reach ${unreachable.map((f) => `${f.name} (${f.reason})`).join('; ')} — ` +
        'it will pick the change up when its daemon next starts',
    );
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
