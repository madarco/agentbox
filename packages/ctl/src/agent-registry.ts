import { postRpcAwait } from './relay-rpc.js';
import { agentUnitsFromWire, type AgentUnits } from './agent-units.js';
import { WATCHED_CREDENTIALS, type WatchedCredential } from './credentials-watcher.js';
import { BAKED_AGENT_SESSIONS, type WatchedAgentSession } from './status-reporter.js';

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
 *
 * OFF THE CRITICAL PATH, for the same reason. The watcher starts on the baked
 * list first and this only ever upgrades it, so no failure mode here can cost a
 * box its fan-out. Awaiting it instead did exactly that: see
 * {@link AGENTS_LIST_TIMEOUT_MS}.
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
  sessionName?: unknown;
  activitySource?: unknown;
  surface?: unknown;
  service?: unknown;
  configRender?: unknown;
}

/**
 * What `agent render <id>` needs from the descriptor, narrowed off the wire.
 *
 * Kept as its own shape rather than importing `AgentConfigRenderSpec` from
 * `@agentbox/core`: the wire is untrusted input, so every field is checked here
 * and the result is what the rest of ctl may assume.
 */
export interface AgentRenderDescriptor {
  agent: string;
  file: string;
  overlayKey: string;
  applyCmd: string;
  dryRunFlag?: string;
  validate?: string;
}

function parseRenderDescriptor(agent: string, raw: unknown): AgentRenderDescriptor | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const file = typeof r.file === 'string' ? r.file : '';
  const overlayKey = typeof r.overlayKey === 'string' ? r.overlayKey : '';
  const applyCmd = typeof r.applyCmd === 'string' ? r.applyCmd : '';
  if (file.length === 0 || overlayKey.length === 0 || applyCmd.length === 0) return null;
  const out: AgentRenderDescriptor = { agent, file, overlayKey, applyCmd };
  if (typeof r.dryRunFlag === 'string' && r.dryRunFlag.length > 0) out.dryRunFlag = r.dryRunFlag;
  if (typeof r.validate === 'string' && r.validate.length > 0) out.validate = r.validate;
  return out;
}

/** What one `agents.list` answer yields: the lists ctl drives from it. */
export interface AgentDescriptors {
  files: readonly WatchedCredential[];
  sessions: readonly WatchedAgentSession[];
  /**
   * Supervisor units contributed by `surface: 'service'` agents.
   *
   * Applied through the existing `Supervisor.reload()` diff rather than
   * `init()`, which keeps the fetch OFF the critical path: the box comes up on
   * `/workspace/agentbox.yaml` exactly as before, and these arrive when they
   * arrive. An unreachable host therefore costs a service agent its unit — not
   * the box its supervisor.
   */
  units: readonly AgentUnits[];
  /**
   * Layered-config descriptors, keyed by agent id. Two consumers: `agent render`
   * reads one, and the daemon reads every `overlayKey` so ctl's config parser
   * stops calling a service agent's overlay block an unknown top-level key.
   */
  renders: readonly AgentRenderDescriptor[];
}

/**
 * Narrow the wire payload, dropping anything malformed rather than throwing.
 *
 * Unknown fields are IGNORED, not rejected: a newer host must never break an
 * older box. Same posture as the in-box `agentbox.yaml` parser, which warns on
 * unknown keys instead of failing.
 */
export function parseAgentDescriptors(
  stdout: string,
  onWarn?: (msg: string) => void,
): AgentDescriptors | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return null;

  const files: WatchedCredential[] = [];
  const sessions: WatchedAgentSession[] = [];
  const units: AgentUnits[] = [];
  const renders: AgentRenderDescriptor[] = [];
  const warn = onWarn ?? ((m: string) => process.stderr.write(`agentbox-ctl: ${m}\n`));
  for (const raw of agents as WireAgent[]) {
    const id = typeof raw?.id === 'string' ? raw.id : null;
    if (!id) continue;

    // An absent `surface` is an older host, and every agent it knew was a TUI.
    const surface = raw.surface === 'service' ? 'service' : 'tui';
    if (surface === 'service' && raw.service !== undefined) {
      const u = agentUnitsFromWire(id, raw.service, warn);
      if (u) units.push(u);
    }
    const render = parseRenderDescriptor(id, raw.configRender);
    if (render) renders.push(render);

    // An agent is probed for activity only if it says it reports any. A row with
    // no `activitySource` has no hooks, no plugin and no scraper, so probing its
    // tmux session would only add a permanently-`unknown` entry to every
    // snapshot. Absent `activitySource` (an older host) is treated as "reports"
    // so the three built-ins keep being probed against a host that predates it.
    const reports =
      raw.activitySource === undefined ||
      (Array.isArray(raw.activitySource) && raw.activitySource.length > 0);
    if (reports) {
      const sessionName = typeof raw.sessionName === 'string' ? raw.sessionName : '';
      if (sessionName.length > 0) sessions.push({ agent: id, sessionName });
    }

    const watches = Array.isArray(raw.watch) ? (raw.watch as WireWatch[]) : [];
    for (const w of watches) {
      if (typeof w?.path !== 'string' || w.path.length === 0) continue;
      const sync = w.sync === 'fanout' ? 'fanout' : 'backup';
      // Only a `fanout` watch posts a credential blob, and only a known shape is
      // validatable — anything else is dropped rather than posted unvalidated.
      if (sync !== 'fanout') continue;
      if (w.shape !== 'claude-oauth' && w.shape !== 'nonempty-json') continue;
      files.push({ agent: id, path: w.path, shape: w.shape });
    }
  }
  // An empty credential list is a malformed answer, not a valid "watch nothing" —
  // refuse it so the caller keeps the baked lists. Sessions are allowed to be
  // empty on their own (a host whose agents all opt out of activity), but not
  // when the credentials were unusable too.
  if (files.length === 0) return null;
  return { files, sessions, units, renders };
}

/**
 * How long to wait for `agents.list` before giving up and keeping the baked list.
 *
 * There is NO other bound on this call. On a cloud box the in-sandbox relay parks
 * every RPC on `HostActionQueue`, whose `enqueue` is deliberately timeout-free,
 * and whose expiry sweep runs only inside `drain()` — which only runs when the
 * host's `CloudBoxPoller` polls. Host off, poller down, or box resumed with the
 * PC asleep and the promise simply never settles, holding a socket and a queue
 * slot open for the life of the daemon.
 *
 * Generous, because the cost of being slow here is nil (the watcher is already
 * running on the baked list) while a premature give-up on a merely-sluggish host
 * leaves a post-bake agent unwatched until the next ctl restart.
 */
const AGENTS_LIST_TIMEOUT_MS = 30_000;

/**
 * Fetch both watch lists, falling back to the baked ones on any failure or if the
 * host does not answer within {@link AGENTS_LIST_TIMEOUT_MS}. Never throws.
 *
 * MUST NOT be awaited on the daemon's critical path — see the call site in
 * `commands/daemon.ts`.
 */
export async function fetchWatchList(): Promise<
  AgentDescriptors & { source: 'host' | 'baked' | 'timeout' }
> {
  const baked = {
    files: WATCHED_CREDENTIALS,
    sessions: BAKED_AGENT_SESSIONS,
    // Nothing is baked here on purpose: units and render descriptors exist only
    // for agents this ctl may never have heard of, so the fallback is "none",
    // never a stale guess.
    units: [],
    renders: [],
  } satisfies AgentDescriptors;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      // unref: a pending timer must never be the reason the daemon stays alive.
      setTimeout(() => resolve('timeout'), AGENTS_LIST_TIMEOUT_MS).unref();
    });
    const res = await Promise.race([postRpcAwait('agents.list', {}), timeout]);
    if (res === 'timeout') return { ...baked, source: 'timeout' };
    if (res.exitCode !== 0) return { ...baked, source: 'baked' };
    const parsed = parseAgentDescriptors(res.stdout);
    if (!parsed) return { ...baked, source: 'baked' };
    // A host that answered with no session rows at all is more likely to be one
    // that predates them than a fleet with activity reporting switched off —
    // keep the baked probes rather than going silent.
    return {
      files: parsed.files,
      sessions: parsed.sessions.length > 0 ? parsed.sessions : baked.sessions,
      units: parsed.units,
      renders: parsed.renders,
      source: 'host',
    };
  } catch {
    return { ...baked, source: 'baked' };
  }
}

/**
 * The same answer, but LOUD — for `agent render`, whose whole job depends on it.
 *
 * {@link fetchWatchList} is a best-effort upgrade of lists that are already
 * running, so every failure there is a silent fallback. A render has no fallback:
 * without the descriptor there is no file to write, and quietly doing nothing
 * would leave a service starting against a config that was never rendered.
 */
export async function fetchAgentDescriptorsOrThrow(): Promise<AgentDescriptors> {
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), AGENTS_LIST_TIMEOUT_MS).unref();
  });
  const res = await Promise.race([postRpcAwait('agents.list', {}), timeout]);
  if (res === 'timeout') {
    throw new Error(`agents.list timed out after ${String(AGENTS_LIST_TIMEOUT_MS)}ms`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`agents.list failed: ${res.stderr.trim() || `exit ${String(res.exitCode)}`}`);
  }
  const parsed = parseAgentDescriptors(res.stdout);
  if (!parsed) throw new Error('agents.list returned a payload this ctl could not parse');
  return parsed;
}
