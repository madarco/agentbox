/**
 * Externally-installed agents — the dynamic half of the registry.
 *
 * The design is the provider one, deliberately: `agentbox agent add <package>`
 * loads the package once, validates the `AgentSyncSpec` it exports, and
 * SNAPSHOTS that spec into `~/.agentbox/agents.json`. Every consumer afterwards
 * reads the snapshot — synchronously, offline, without importing the package —
 * exactly as `resolveProviderDescriptor` reads `plugins.json`.
 *
 * Snapshotting costs nothing here because `AgentSyncSpec` is ALREADY pure JSON.
 * That was not an accident: the spec is shipped into a box whose `agentbox-ctl`
 * may predate the agent (over the `agents.list` RPC), so it has never been
 * allowed to hold a function. The same property that lets a spec cross into a
 * box lets it be written to a file and read back.
 *
 * This file is DATA only. Loading a plugin agent's behavior (its
 * `AgentSyncModule`) is a separate, lazy `import()` of `resolvedEntry` — and
 * that variable specifier is precisely why a plugin agent never enters the
 * workspace dependency graph, and so is structurally exempt from the package
 * cycle the built-in split exists to avoid.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSyncSpec } from '@agentbox/core';

export const AGENTS_FILE = join(homedir(), '.agentbox', 'agents.json');

/** Agent-plugin API versions this build accepts. */
export const SUPPORTED_AGENT_API_VERSIONS: readonly number[] = [1];

export function isSupportedAgentApiVersion(v: number): boolean {
  return SUPPORTED_AGENT_API_VERSIONS.includes(v);
}

export interface AgentPluginRecord {
  /** Package name as installed. */
  packageName: string;
  /** Absolute path to the package's resolved entry module, recorded at add time. */
  resolvedEntry: string;
  /** Package version at add time (informational). */
  version: string;
  /**
   * The spec rows this package contributes, keyed by agent id. This is the
   * snapshot — it is what every reader resolves against, so no consumer ever
   * has to `import()` the package just to learn that an agent exists.
   */
  specs: Record<string, AgentSyncSpec>;
  /** The agent API version the package declared (compat gate). */
  apiVersion: number;
  /** ISO timestamp the package was added. */
  addedAt: string;
}

export interface AgentsFile {
  version: 1;
  agents: AgentPluginRecord[];
}

export const AGENTS_FILE_VERSION = 1;

const EMPTY: AgentsFile = { version: AGENTS_FILE_VERSION, agents: [] };

/**
 * Every field an `AgentSyncSpec` cannot work without. Checked at ADD time so a
 * malformed package is refused once, at the moment someone can fix it — rather
 * than at box-create time, which is both far away and much worse.
 */
const REQUIRED_SPEC_FIELDS = [
  'id',
  'aliases',
  'sessionName',
  'binary',
  'install',
  'dockerVolume',
  'staticPaths',
  'credential',
  'forwardedEnvKeys',
  'boxRunEnv',
  'caps',
] as const;

/** Why a spec was rejected, or null when it is usable. */
export function agentSpecProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'not an object';
  const spec = raw as Record<string, unknown>;
  const missing = REQUIRED_SPEC_FIELDS.filter((f) => spec[f] === undefined);
  if (missing.length > 0) return `missing required field(s): ${missing.join(', ')}`;
  if (typeof spec.id !== 'string' || spec.id.length === 0) return '`id` must be a non-empty string';
  if (!Array.isArray(spec.aliases)) return '`aliases` must be an array';
  if (!Array.isArray(spec.staticPaths)) return '`staticPaths` must be an array';
  // A spec that isn't JSON-round-trippable cannot reach a box: it travels to
  // `agentbox-ctl` over `agents.list` as JSON. Catching it here keeps that
  // guarantee true for plugin agents too.
  try {
    JSON.parse(JSON.stringify(raw));
  } catch {
    return 'not JSON-serializable';
  }
  return null;
}

function normalize(raw: unknown): AgentsFile {
  const parsed = raw as AgentsFile;
  if (!parsed || parsed.version !== AGENTS_FILE_VERSION || !Array.isArray(parsed.agents)) {
    // Unrecognized shape → treat as empty, never throw. A corrupt agents.json
    // must not brick every box command; the same rule `plugins.json` follows.
    return { ...EMPTY };
  }
  return parsed;
}

/**
 * Synchronous read. Missing or corrupt file → empty.
 *
 * Sync on purpose: this feeds the spec table, which the relay, the hub and
 * `sandbox-core` all read without awaiting. It is the same trade
 * `readPluginRegistrySync` makes for providers.
 */
export function readAgentRegistrySync(path: string = AGENTS_FILE): AgentsFile {
  try {
    if (!existsSync(path)) return { ...EMPTY };
    return normalize(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY };
  }
}

/**
 * The spec rows contributed by installed agent packages, in registration order.
 *
 * A record whose API version this build does not support is skipped rather than
 * fatal: an agent added by a newer AgentBox must not break an older one, it
 * just isn't available. Same for an individual spec that fails validation — the
 * file may have been hand-edited since `agent add` checked it.
 */
export function pluginAgentSpecs(path: string = AGENTS_FILE): AgentSyncSpec[] {
  const out: AgentSyncSpec[] = [];
  for (const record of readAgentRegistrySync(path).agents) {
    if (!isSupportedAgentApiVersion(record.apiVersion)) continue;
    for (const spec of Object.values(record.specs ?? {})) {
      if (agentSpecProblem(spec) === null) out.push(spec);
    }
  }
  return out;
}

/** The package that contributed `agentId`, or undefined for a built-in. */
export function pluginForAgent(
  agentId: string,
  path: string = AGENTS_FILE,
): AgentPluginRecord | undefined {
  return readAgentRegistrySync(path).agents.find((r) => agentId in (r.specs ?? {}));
}

/**
 * Read for a read-modify-WRITE. Unlike `readAgentRegistrySync` — which degrades
 * a corrupt file to empty so no command bricks — this REFUSES to proceed on an
 * unparseable file, because the alternative is overwriting a recoverable
 * `agents.json` and silently dropping every other registered agent. A genuinely
 * missing file is still an empty start.
 */
async function readForWrite(path: string): Promise<AgentsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON — fix or remove it before adding an agent`);
  }
  const file = parsed as AgentsFile;
  if (!file || file.version !== AGENTS_FILE_VERSION || !Array.isArray(file.agents)) {
    throw new Error(`${path} is not a recognized agent registry — fix or remove it`);
  }
  return file;
}

async function writeRegistry(path: string, file: AgentsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Register (or re-register) one package's agents. Replaces any prior record for it. */
export async function addAgentPluginRecord(
  record: AgentPluginRecord,
  path: string = AGENTS_FILE,
): Promise<void> {
  const file = await readForWrite(path);
  file.agents = [...file.agents.filter((r) => r.packageName !== record.packageName), record];
  await writeRegistry(path, file);
}

/** Remove a package's registration. Returns false when it wasn't registered. */
export async function removeAgentPluginRecord(
  packageName: string,
  path: string = AGENTS_FILE,
): Promise<boolean> {
  const file = await readForWrite(path);
  const before = file.agents.length;
  file.agents = file.agents.filter((r) => r.packageName !== packageName);
  if (file.agents.length === before) return false;
  await writeRegistry(path, file);
  return true;
}
