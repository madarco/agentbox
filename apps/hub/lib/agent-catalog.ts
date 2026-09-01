/**
 * Which coding agents this hub can offer, and which of them this machine is
 * actually set up for.
 *
 * The companion to `host-carried.ts`: that one answers "which of my files will a
 * box receive", this one answers "which agents should a picker show me". Both
 * read the same registry and both are present-only — a path that isn't here is
 * a path the create path would not use either.
 *
 * Deliberately NOT a hardcoded list: the source of truth is the agent registry,
 * which includes anything `agentbox agent add` registered. A picker built from
 * this therefore covers plugin agents that no table here could name.
 *
 * Runs in the custom server's scope (outside Next's bundle) and is handed to the
 * route as plain data — see the `__AGENTBOX_HUB_SYSTEM` seam.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Display names for the built-in agents. A plugin agent has no entry and falls
 * back to its id, which is the honest answer — a label is presentation, and the
 * spec carries none.
 */
export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export interface AgentCatalogEntry {
  id: string;
  label: string;
  /**
   * True when this machine holds the agent's own config or an AgentBox-saved
   * login for it. A client uses it to stop offering an agent the user has never
   * set up; it is NOT a gate — the agent still installs on demand inside a box,
   * so creating with a `false` agent works, it just isn't the default offer.
   */
  installed: boolean;
}

/** A spec shaped like `AGENT_SYNC_SPECS[]` — structurally typed to stay decoupled. */
export interface AgentSpecLike {
  id: string;
  hidden?: boolean;
  staticPaths: readonly { hostHomeRel: readonly string[]; stagedAs?: string }[];
  credential?: { hostBackup?: string };
}

export interface CollectOptions {
  home?: string;
  /** Seam for tests; defaults to the real fs. */
  exists?: (p: string) => boolean;
}

/**
 * The agent catalog for this machine.
 *
 * `specs` is passed in rather than imported so this module stays free of
 * `@agentbox/*` (and therefore of execa) — the caller in `server.ts` supplies
 * `visibleAgentSpecs()`.
 */
export function collectAgentCatalog(
  specs: readonly AgentSpecLike[],
  opts: CollectOptions = {},
): AgentCatalogEntry[] {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;

  return specs.map((spec) => ({
    id: spec.id,
    label: AGENT_LABELS[spec.id] ?? spec.id,
    installed: isSetUp(spec, home, exists),
  }));
}

function isSetUp(spec: AgentSpecLike, home: string, exists: (p: string) => boolean): boolean {
  for (const sp of spec.staticPaths) {
    // A `state` path is per-box runtime state, not host setup: OpenCode's
    // ~/.local/state/opencode rides along with the volume but never enables it
    // (create.ts's `wantOpencode` gates on the config/data dirs alone). Counting
    // it would report an agent as set up that create would not even mount a
    // config volume for. Generic on purpose — the marker is registry data, so a
    // future agent with its own state dir gets the same treatment for free.
    if (sp.stagedAs === 'state') continue;
    if (exists(join(home, ...sp.hostHomeRel))) return true;
  }
  // An AgentBox-saved login counts on its own: the user may have removed the
  // host app but the credential still seeds a box, so the agent is usable.
  // Absolute (it is `~/.agentbox/<id>-credentials.json`, baked at module load in
  // the registry), so it does NOT follow an overridden `home`.
  const backup = spec.credential?.hostBackup;
  return backup != null && exists(backup);
}
