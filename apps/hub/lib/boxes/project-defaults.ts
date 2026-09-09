// What a create picker should open on for a given project: the provider and
// agent that project's last create used, clamped to what this host can actually
// offer today. Pure — no hub, no store — so both the web modal and the hosted
// (registration-derived) source use the same rules, and they are unit-testable.
//
// The memory is advisory. A remembered provider can be uninstalled, unbaked, or
// owned by a control box; a remembered agent can be an `agentbox agent add`
// plugin that was removed. Every read goes through here so an impossible
// pre-selection degrades to the plain default instead of a create that fails.
import type { AgentOption, Project, ProviderOption } from './types';

/** The fallbacks, matching what the pickers did before any memory existed. */
export const FALLBACK_PROVIDER = 'docker';
export const FALLBACK_AGENT = 'claude';

/**
 * Whether a provider id can be picked here: it has to be in the catalog, be
 * baked/usable, and belong to THIS host — an `origin: 'hub'` row describes a
 * control box's provider and is rendered disabled.
 */
export function usableProvider(
  id: string | null | undefined,
  providers: readonly ProviderOption[],
): boolean {
  if (!id) return false;
  const p = providers.find((o) => o.id === id);
  return !!p && p.configured && p.origin !== 'hub';
}

/**
 * The provider a create form should open on. A `docker:<alias>` remote-docker
 * spec round-trips only when the catalog was fetched with `hosts=expand` (the
 * create picker does); otherwise it fails the lookup and falls back, which is
 * the right answer — that host isn't offered.
 */
export function defaultProviderFor(
  project: Pick<Project, 'lastProvider'> | undefined,
  providers: readonly ProviderOption[],
): string {
  const want = project?.lastProvider ?? undefined;
  return usableProvider(want, providers) ? want! : FALLBACK_PROVIDER;
}

/**
 * The agent a create form should open on. Falls back to `claude` when the
 * catalog has it (its historical default) and to the catalog's first entry
 * otherwise — a hub whose registry doesn't carry claude still gets a valid pick.
 */
export function defaultAgentFor(
  project: Pick<Project, 'lastAgent'> | undefined,
  agents: readonly AgentOption[],
): string {
  const want = project?.lastAgent ?? undefined;
  if (want && agents.some((a) => a.id === want)) return want;
  if (agents.some((a) => a.id === FALLBACK_AGENT)) return FALLBACK_AGENT;
  return agents[0]?.id ?? FALLBACK_AGENT;
}

/** One box registration, as much of it as the last-used derivation needs. */
export interface LastUsedRegistration {
  /** The cloud backend (`hetzner`, `e2b`, …) — the only field that names a real provider. */
  backend?: string;
  agent?: string;
  createdAt?: string;
  registeredAt: string;
}

/**
 * The one wire spelling a registration can carry for an agent id (`toQueueKind`
 * maps 'claude' → 'claude-code' on the queue boundary). Anything else is passed
 * through untouched rather than dropped: a plugin or service agent is a
 * perfectly good memory, and `defaultAgentFor`'s catalog check is what judges
 * whether this hub can still offer it. Inlined rather than imported from
 * @agentbox/core because this module is pulled into the client bundle.
 */
const AGENT_WIRE_ALIASES: Record<string, string> = { 'claude-code': 'claude' };

/**
 * Derive the same three fields from box registrations, for the hosted
 * (control-box) path where there is no local project registry to read. Newest
 * registration wins — it is the closest thing that surface has to "what this
 * project was last created with".
 */
export function lastUsedFromRegistrations(regs: readonly LastUsedRegistration[]): {
  lastProvider?: string;
  lastAgent?: string;
  lastUsedAt?: number;
} {
  let newest: { at: number; reg: LastUsedRegistration } | null = null;
  for (const reg of regs) {
    const at = Date.parse(reg.createdAt ?? reg.registeredAt);
    if (!Number.isFinite(at)) continue;
    if (!newest || at > newest.at) newest = { at, reg };
  }
  if (!newest) return {};
  // `backend` only. The registration's `kind` is 'cloud'/'docker', never a
  // provider id, so falling back to it would emit `lastProvider: 'cloud'` —
  // a value that always loses the clamp. Saying nothing is more honest.
  const provider = newest.reg.backend;
  const raw = newest.reg.agent;
  const agent = raw ? (AGENT_WIRE_ALIASES[raw] ?? raw) : undefined;
  return {
    ...(provider ? { lastProvider: provider } : {}),
    ...(agent && agent !== 'none' ? { lastAgent: agent } : {}),
    lastUsedAt: newest.at,
  };
}
