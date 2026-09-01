/**
 * The per-agent box->host pull, as a registered hook with a data-driven default.
 *
 * WHY A HOOK AND NOT ONE SHARED FUNCTION. An agent's config is not always a file
 * tree. Codex keeps five SQLite databases under `~/.codex` and opencode keeps
 * one, and a database is not copyable: a running agent's data lives in the
 * write-ahead log, so the main file alone is stale and the triple copied
 * together is a torn read (measured: codex's `state_5.sqlite` was 4 KB against a
 * 1.79 MB `-wal`). Collapsing the three pulls into one generic file-copy would
 * have locked that in. Instead: a default that covers the flat case from
 * `AgentPullSpec`, and a hook for an agent whose state needs handling —
 * `pullSqliteSnapshot` is the supported way to do it.
 *
 * Registered the way the docker and cloud module registries are, and for the
 * same reason: `sandbox-core` receives an agent's behavior, it never imports an
 * agent package.
 */

import type { AgentId, SyncTransport } from '@agentbox/core';
import { resolveAgentSpec } from './registry.js';
import { pullFlatConfigViaTransport } from './agent-pull.js';

export interface AgentPullOptions {
  /** Report what WOULD be pulled and write nothing. */
  dryRun?: boolean;
  /** Host home to pull into. Overridable for tests. */
  hostHome?: string;
}

export interface AgentPullResult {
  /** Host-relative names newly brought over (empty = nothing to do). */
  newItems: string[];
}

export interface AgentPullModule {
  readonly id: AgentId;
  /**
   * Pull this agent's box-side config back to the host, ADDITIVELY — the host
   * copy always wins, so this only ever adds what the host does not have.
   */
  pull(t: SyncTransport, opts: AgentPullOptions): Promise<AgentPullResult>;
}

const MODULES = new Map<AgentId, AgentPullModule>();

export function registerAgentPullModule(mod: AgentPullModule): void {
  MODULES.set(mod.id, mod);
}

export function registeredAgentPullModules(): AgentPullModule[] {
  return [...MODULES.values()];
}

/**
 * The pull for `agent` — its registered module, or the spec-driven default.
 *
 * The default is not a fallback for a broken registration: an agent whose
 * config is a flat set of files (which is most of them) declares
 * `pull.items` and needs no code at all. That is the same "an agent is a row of
 * data" rule the install recipe follows.
 */
export function agentPull(
  agent: AgentId,
  t: SyncTransport,
  opts: AgentPullOptions = {},
): Promise<AgentPullResult> {
  const mod = MODULES.get(agent);
  if (mod) return mod.pull(t, opts);
  return pullFlatConfigViaTransport(agent, t, opts);
}

/**
 * Copy a SQLite database out of a box CONSISTENTLY, for an agent whose state is
 * a database rather than a file tree.
 *
 * Uses SQLite's own online-backup API through the box's Python (or Node 24's
 * `node:sqlite`), which checkpoints the WAL into a single self-contained file —
 * so the result is readable, unlike a byte-copy of a live `.sqlite` (+`-wal`
 * +`-shm`) triple. Neither runtime needs installing: both are already in the box
 * image, which is why this needs no re-bake.
 *
 * Returns false when the box has neither runtime or the database is absent; the
 * caller decides whether that is fatal.
 */
export async function pullSqliteSnapshot(
  t: SyncTransport,
  boxDbPath: string,
  hostDestPath: string,
): Promise<boolean> {
  const tmp = `${boxDbPath}.agentbox-snapshot`;
  const py =
    `import sqlite3,sys\n` +
    `src=sqlite3.connect('file:${boxDbPath}?mode=ro',uri=True)\n` +
    `dst=sqlite3.connect('${tmp}')\n` +
    `src.backup(dst); dst.close(); src.close()\n`;
  const snap = await t.exec([
    'sh',
    '-c',
    `[ -f '${boxDbPath}' ] || exit 3; ` +
      `if command -v python3 >/dev/null 2>&1; then python3 - <<'PY'\n${py}PY\n` +
      `elif command -v node >/dev/null 2>&1; then ` +
      `node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('${boxDbPath}');d.exec(\\"VACUUM INTO '${tmp}'\\");d.close()"; ` +
      `else exit 4; fi`,
  ]);
  if (snap.exitCode !== 0) return false;
  try {
    await t.pullFile(tmp, hostDestPath);
    return true;
  } finally {
    await t.exec(['rm', '-f', tmp]);
  }
}

/** The box dir an agent's pull reads from, per the registry. */
export function agentPullBoxDir(agent: AgentId): string {
  const spec = resolveAgentSpec(agent);
  const dir = spec.staticPaths[0]?.boxDir;
  if (!dir) throw new Error(`agent '${agent}' declares no staticPaths to pull from`);
  return dir;
}
