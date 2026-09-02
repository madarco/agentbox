/**
 * Supervisor units synthesized from a `surface: 'service'` agent's descriptor.
 *
 * The wire block (`AgentServiceSpec`, `@agentbox/core`) mirrors ctl's own
 * `ServiceSpec`/`TaskSpec` field-for-field, so this is a FIELD COPY plus the
 * defaults ctl's yaml parser would have applied — not a translation layer. Every
 * decision it makes beyond copying is one of those defaults.
 *
 * Defensive throughout: the payload comes from a host that may be newer than
 * this baked ctl. A malformed unit is DROPPED with a warning rather than thrown,
 * because the alternative is a box whose supervisor refuses to start over an
 * agent it did not have to run at all.
 */

import {
  DEFAULT_BACKOFF,
  DEFAULT_PROBE_HOST,
  DEFAULT_PROBE_INITIAL_DELAY_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_ON_TIMEOUT,
  DEFAULT_PROBE_TIMEOUT_MS,
  validateUnitGraph,
  type CtlConfig,
  type ReadyProbe,
  type RestartPolicy,
  type RunOnceSpec,
  type ServiceSpec,
  type TaskSpec,
} from './config.js';

/** The units one service agent contributes. */
export interface AgentUnits {
  /** The agent this came from, for warning text. */
  agent: string;
  services: ServiceSpec[];
  tasks: TaskSpec[];
}

const UNIT_NAME_RE = /^[A-Za-z0-9_-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wireCommand(raw: unknown): string | string[] | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')) {
    return raw as string[];
  }
  return null;
}

function wireEnv(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      out[k] = String(v);
  }
  return out;
}

function wireNeeds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function wireRestart(raw: unknown): RestartPolicy {
  return raw === 'always' || raw === 'never' || raw === 'on-failure' ? raw : 'on-failure';
}

function wireRunOnce(raw: unknown): RunOnceSpec | undefined {
  if (raw === 'marker') return { kind: 'marker' };
  if (isPlainObject(raw) && typeof raw.check === 'string' && raw.check.trim().length > 0) {
    return { kind: 'check', command: raw.check };
  }
  return undefined;
}

/**
 * `readyWhen` → ctl's `ReadyProbe`, with the same defaults the yaml parser
 * applies. Precedence http > port > logMatch: the descriptor declares one, and
 * ranking them beats silently picking whichever key iteration happened to hit.
 */
function wireProbe(
  raw: unknown,
  onWarn: (m: string) => void,
  where: string,
): ReadyProbe | undefined {
  if (!isPlainObject(raw)) return undefined;
  const common = {
    intervalMs: DEFAULT_PROBE_INTERVAL_MS,
    initialDelayMs: DEFAULT_PROBE_INITIAL_DELAY_MS,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    onTimeout: DEFAULT_PROBE_ON_TIMEOUT,
  };
  if (typeof raw.http === 'string' && raw.http.length > 0) {
    return { kind: 'http', url: raw.http, ...common };
  }
  if (typeof raw.port === 'number' && Number.isInteger(raw.port)) {
    return { kind: 'port', port: raw.port, host: DEFAULT_PROBE_HOST, ...common };
  }
  if (typeof raw.logMatch === 'string' && raw.logMatch.length > 0) {
    try {
      return {
        kind: 'log_match',
        pattern: new RegExp(raw.logMatch),
        timeoutMs: common.timeoutMs,
        onTimeout: common.onTimeout,
      };
    } catch {
      onWarn(`${where}.readyWhen.logMatch is not a valid regex; ignoring the probe`);
      return undefined;
    }
  }
  return undefined;
}

/**
 * Narrow one agent's wire `service` block into supervisor units.
 *
 * Returns null when the block is unusable — no name, no command, or a name that
 * would not have been a legal unit name in `agentbox.yaml`.
 */
export function agentUnitsFromWire(
  agent: string,
  raw: unknown,
  onWarn: (m: string) => void,
): AgentUnits | null {
  if (!isPlainObject(raw)) return null;
  const where = `agents.list[${agent}].service`;
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!UNIT_NAME_RE.test(name)) {
    onWarn(`${where}.name "${name}" is not a valid unit name; skipping this agent's units`);
    return null;
  }
  const command = wireCommand(raw.command);
  if (!command) {
    onWarn(`${where}.command is missing or malformed; skipping this agent's units`);
    return null;
  }

  const tasks: TaskSpec[] = [];
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!isPlainObject(t)) continue;
    const tName = typeof t.name === 'string' ? t.name : '';
    const tCommand = wireCommand(t.command);
    if (!UNIT_NAME_RE.test(tName) || !tCommand) {
      onWarn(`${where}.tasks[${tName || '?'}] is malformed; skipping it`);
      continue;
    }
    const runOnce = wireRunOnce(t.runOnce);
    const task: TaskSpec = {
      name: tName,
      command: tCommand,
      cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      env: wireEnv(t.env),
      needs: wireNeeds(t.needs),
    };
    if (runOnce) task.runOnce = runOnce;
    tasks.push(task);
  }

  const service: ServiceSpec = {
    name,
    command,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    env: wireEnv(raw.env),
    autostart: true,
    restart: wireRestart(raw.restart),
    backoff: { ...DEFAULT_BACKOFF },
    needs: wireNeeds(raw.needs),
    readyWhen: wireProbe(raw.readyWhen, onWarn, where),
  };
  const expose = raw.expose;
  if (
    isPlainObject(expose) &&
    typeof expose.port === 'number' &&
    Number.isInteger(expose.port) &&
    typeof expose.as === 'number' &&
    Number.isInteger(expose.as)
  ) {
    service.expose = { port: expose.port, as: expose.as };
  }

  return { agent, services: [service], tasks };
}

/**
 * Fold a service agent's units into the workspace config.
 *
 * THE WORKSPACE ALWAYS WINS. A unit whose name already exists in
 * `/workspace/agentbox.yaml` is dropped here, so a user can override the
 * synthesized service (or task) simply by declaring one with the same name —
 * which is the documented escape hatch and the reason the agent's unit names are
 * part of its public surface.
 *
 * The `expose:` collision is called out rather than resolved silently: only one
 * service may publish the box's web port, so the agent's `expose` is dropped
 * with a loud warning when the workspace already claims it. A silent drop here
 * reads to the user as "the box URL is broken for no reason".
 *
 * Returns the base config unchanged if the merge would produce an invalid unit
 * graph — a dangling `needs:` or a cycle must not cost the box the services it
 * already had.
 */
export function mergeAgentUnits(
  base: CtlConfig,
  units: readonly AgentUnits[],
  onWarn: (m: string) => void,
): CtlConfig {
  if (units.length === 0) return base;
  const taken = new Set<string>([
    ...base.services.map((s) => s.name),
    ...base.tasks.map((t) => t.name),
  ]);
  const workspaceExposes = base.services.find((s) => s.expose);

  const services = [...base.services];
  const tasks = [...base.tasks];
  for (const u of units) {
    for (const t of u.tasks) {
      if (taken.has(t.name)) {
        onWarn(
          `agent "${u.agent}": task "${t.name}" is declared in agentbox.yaml; the workspace wins`,
        );
        continue;
      }
      taken.add(t.name);
      tasks.push(t);
    }
    for (const s of u.services) {
      if (taken.has(s.name)) {
        onWarn(
          `agent "${u.agent}": service "${s.name}" is declared in agentbox.yaml; the workspace wins`,
        );
        continue;
      }
      taken.add(s.name);
      if (s.expose && workspaceExposes) {
        onWarn(
          `agent "${u.agent}": service "${s.name}" wants expose: but "${workspaceExposes.name}" in agentbox.yaml already publishes the box web port; ` +
            `the agent's expose is dropped. Remove one of the two.`,
        );
        services.push({ ...s, expose: undefined });
        continue;
      }
      services.push(s);
    }
  }

  const merged: CtlConfig = { ...base, services, tasks };
  try {
    validateUnitGraph(merged.tasks, merged.services);
  } catch (err) {
    onWarn(
      `agent units rejected (${err instanceof Error ? err.message : String(err)}); keeping the workspace config`,
    );
    return base;
  }
  return merged;
}
