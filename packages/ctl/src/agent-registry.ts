import { postRpcAwait } from './relay-rpc.js';
import { WATCHED_CREDENTIALS, type WatchedCredential } from './credentials-watcher.js';

/**
 * The agent watch list, pulled from the host over `agents.list`.
 *
 * Why this exists: `agentbox-ctl` is BAKED INTO THE BOX IMAGE, so its compiled-in
 * list is frozen at bake time. A box built from a snapshot taken before an agent
 * existed never watches that agent's files. A plugin-supplied agent is
 * `ondemand`-only and can never be baked at all, so without this it would be
 * permanently invisible to ctl.
 *
 * Pulled rather than pushed as a file: a file has to be written by the PROVIDER
 * (cloud bootstrap, docker box-env, and a hand-written equivalent in every
 * community provider), which makes its shape a contract each of them implements.
 * Over RPC the shape stays host-side and providers stay uninvolved.
 *
 * Reconciled ONCE at daemon start, never polled — on a control box a poll would
 * be a WAN round trip per box per minute (the reason `ToolLinksWatcher` stopped
 * polling too). That covers a new box, a restarted box and a resumed box.
 *
 * NOT yet covered: a box already running when the host's agent list changes; it
 * picks the change up on the next ctl restart. `ToolLinksWatcher` solves the
 * equivalent with `agentbox-ctl tool relink` over `Provider.exec`, but that works
 * because tool links are on-disk state a separate process can rewrite — this list
 * lives in the daemon's memory, so the same push needs a ctl socket op. Left for
 * a follow-up; the startup reconcile is what turns adding an agent from
 * "re-bake every base" into "restart ctl".
 *
 * FAILURE IS SILENT AND KEEPS THE BAKED LIST. An unreachable relay, an older
 * host with no `agents.list`, or a malformed payload must all leave the box
 * watching what it already watched — never nothing. Losing the credential
 * watcher would silently break login fan-out for the whole fleet.
 */

interface WireWatch {
  path?: unknown;
  sync?: unknown;
  shape?: unknown;
  hostDest?: unknown;
}
interface WireAgent {
  id?: unknown;
  watch?: unknown;
}

/**
 * Narrow the wire payload, dropping anything malformed rather than throwing.
 *
 * Unknown fields are IGNORED, not rejected: a newer host must never break an
 * older box. Same posture as the in-box `agentbox.yaml` parser, which warns on
 * unknown keys instead of failing.
 */
export function parseAgentDescriptors(stdout: string): WatchedCredential[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return null;

  const out: WatchedCredential[] = [];
  for (const raw of agents as WireAgent[]) {
    const id = typeof raw?.id === 'string' ? raw.id : null;
    if (!id) continue;
    const watches = Array.isArray(raw.watch) ? (raw.watch as WireWatch[]) : [];
    for (const w of watches) {
      if (typeof w?.path !== 'string' || w.path.length === 0) continue;
      const sync = w.sync === 'fanout' ? 'fanout' : 'backup';
      // Only a `fanout` watch posts a credential blob, and only a known shape is
      // validatable — anything else is dropped rather than posted unvalidated.
      if (sync !== 'fanout') continue;
      if (w.shape !== 'claude-oauth' && w.shape !== 'nonempty-json') continue;
      out.push({ agent: id as WatchedCredential['agent'], path: w.path, shape: w.shape });
    }
  }
  // An empty list is a malformed answer, not a valid "watch nothing" — refuse it
  // so the caller keeps the baked list.
  return out.length > 0 ? out : null;
}

/**
 * Fetch the watch list, falling back to the baked one on any failure.
 * Never throws.
 */
export async function fetchWatchList(): Promise<{
  files: readonly WatchedCredential[];
  source: 'host' | 'baked';
}> {
  try {
    const res = await postRpcAwait('agents.list', {});
    if (res.exitCode !== 0) return { files: WATCHED_CREDENTIALS, source: 'baked' };
    const parsed = parseAgentDescriptors(res.stdout);
    if (!parsed) return { files: WATCHED_CREDENTIALS, source: 'baked' };
    return { files: parsed, source: 'host' };
  } catch {
    return { files: WATCHED_CREDENTIALS, source: 'baked' };
  }
}
