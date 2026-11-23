import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoKey, tryGetMachineId } from '@agentbox/config';
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  hostMemoryDir,
  safeMemoryPath,
  type AgentHistoryMemory,
  type HistoryMemorySink,
  type MemoryOrigin,
  type MemoryPutResult,
  type MemorySeedReply,
} from '@agentbox/core';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { BoxRegistration } from '../types.js';
import { isDockerBox, projectCaptureEnabled, projectRootOf } from './history-relay.js';

/**
 * The relay's half of agent memory (docs/agent-history-plan.md, Phase 4):
 * answers ctl's `history.memory.seed` / `history.memory.put` for every box,
 * docker included (memory lives on the box's own disk on every provider).
 *
 * Seeding works with no hub behind the relay: the set is then the host copy
 * from this machine's agent dir, which is where the create ran. Write-back
 * needs the hub's store.
 */

export interface MemoryAgent {
  agent: string;
  /** Host config dir (`~/.claude`). */
  hostConfigDir: string;
  mem: AgentHistoryMemory;
}

/** Every agent whose registry row declares a memory location (first one only). */
export function memoryAgents(home: string = homedir()): MemoryAgent[] {
  const out: MemoryAgent[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    const mem = spec.history?.memory?.[0];
    const rel = spec.staticPaths[0]?.hostHomeRel;
    if (!mem || !rel) continue;
    out.push({ agent: spec.id, hostConfigDir: join(home, ...rel), mem });
  }
  return out;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Regular files under `dir` (no symlinks followed), capped like the store. */
export async function readMemoryDir(dir: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const out: Array<{ path: string; bytes: Buffer }> = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MEMORY_MAX_FILES) return;
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile() && st.size <= MEMORY_FILE_MAX_BYTES && safeMemoryPath(r)) {
        out.push({ path: r, bytes: await readFile(p) });
      }
    }
  };
  await walk(dir, '');
  return out;
}

export interface MemoryRelayDeps {
  /** The hub's store; absent on a relay with no hub (seed = host copy, no write-back). */
  sink?: HistoryMemorySink;
  /** Exact-value redaction of a file before it is stored (the history redactor). */
  redact?: (bytes: Uint8Array) => Promise<Uint8Array>;
  log(line: string): void;
  /** Tests. */
  agents?: () => MemoryAgent[];
  captureEnabled?: (reg: BoxRegistration) => Promise<boolean>;
  projectRoot?: (reg: BoxRegistration) => Promise<string | null>;
  gitOrigin?: (folder: string) => Promise<string | undefined>;
}

/** `origin` of a folder on this machine, or undefined. */
export function gitOrigin(folder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', folder, 'remote', 'get-url', 'origin'], { timeout: 5_000 }, (err, out) =>
      resolve(err ? undefined : out.trim() || undefined),
    );
  });
}

export class MemoryRelay {
  constructor(private readonly deps: MemoryRelayDeps) {}

  private agents(): MemoryAgent[] {
    return (this.deps.agents ?? memoryAgents)();
  }

  /**
   * `(repo key, project root)` of a box; the key is null when nothing names its
   * repo. A registration re-pushed from state after a relay restart carries no
   * `originUrl`, so the project folder's `origin` is read before falling back
   * to the local key: the key must not change with how the box registered.
   */
  private async keyOf(reg: BoxRegistration): Promise<{ key: string | null; root: string | null }> {
    const root = await (this.deps.projectRoot ?? projectRootOf)(reg);
    const machineId = tryGetMachineId() ?? undefined;
    const origin =
      reg.originUrl ?? (root ? await (this.deps.gitOrigin ?? gitOrigin)(root) : undefined);
    const key =
      repoKey(origin, { machineId }) ?? (root && machineId ? `local:${machineId}:${root}` : null);
    return { key, root };
  }

  private origin(reg: BoxRegistration): MemoryOrigin {
    const hostId = tryGetMachineId();
    return {
      boxId: reg.boxId,
      boxName: reg.name,
      provider: isDockerBox(reg) ? 'docker' : (reg.backend ?? 'cloud'),
      ...(hostId ? { hostId } : {}),
    };
  }

  async seed(reg: BoxRegistration): Promise<MemorySeedReply> {
    const { key, root } = await this.keyOf(reg);
    const capture = await (this.deps.captureEnabled ?? projectCaptureEnabled)(reg);
    const store = this.deps.sink && capture && key ? this.deps.sink : null;
    const hostId = tryGetMachineId();
    const agents: MemorySeedReply['agents'] = [];
    for (const a of this.agents()) {
      const host = root ? await readMemoryDir(hostMemoryDir(a.hostConfigDir, a.mem, root)) : [];
      let files: Array<{ path: string; bytes: Uint8Array; sha256: string }> | null;
      if (store && key) {
        try {
          files = await store.memorySeed({
            repoKey: key,
            agent: a.agent,
            scope: a.mem.scope,
            hostFiles: host,
            origin: { boxId: null, provider: 'host', ...(hostId ? { hostId } : {}) },
          });
        } catch (e) {
          this.deps.log(`memory: seed ${reg.name}: ${e instanceof Error ? e.message : String(e)}`);
          files = host.map((f) => ({ ...f, sha256: sha(f.bytes) }));
        }
      } else {
        files = host.map((f) => ({ ...f, sha256: sha(f.bytes) }));
      }
      agents.push({
        agent: a.agent,
        boxDir: a.mem.boxDir,
        scope: a.mem.scope,
        // Nothing known anywhere: leave whatever the box holds alone.
        files:
          files.length === 0 && !store
            ? null
            : files.map((f) => ({
                path: f.path,
                content: Buffer.from(f.bytes).toString('base64'),
                sha256: f.sha256,
              })),
      });
    }
    const reason = !this.deps.sink
      ? 'this relay has no hub'
      : !capture
        ? 'history.capture is off for this project'
        : !key
          ? 'the box has no repo to key its memory by'
          : undefined;
    return { agents, writeBack: store !== null, ...(reason ? { reason } : {}) };
  }

  async put(reg: BoxRegistration, params: unknown): Promise<MemoryPutResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    const agent = typeof p.agent === 'string' ? p.agent : '';
    const path = safeMemoryPath(p.path);
    const a = this.agents().find((x) => x.agent === agent);
    const deleted = p.deleted === true;
    if (!a || !path || (!deleted && typeof p.content !== 'string')) {
      return { ok: false, code: 'invalid', message: 'malformed memory.put' };
    }
    const { key } = await this.keyOf(reg);
    if (
      !this.deps.sink ||
      !key ||
      !(await (this.deps.captureEnabled ?? projectCaptureEnabled)(reg))
    ) {
      return { ok: false, code: 'disabled', message: 'memory write-back is off for this box' };
    }
    let bytes: Uint8Array | null = null;
    if (!deleted) {
      const raw = Buffer.from(p.content as string, 'base64');
      if (raw.length > MEMORY_FILE_MAX_BYTES) {
        return { ok: false, code: 'invalid', message: 'memory file too large' };
      }
      bytes = this.deps.redact ? await this.deps.redact(raw) : raw;
    }
    try {
      const r = await this.deps.sink.memoryPut({
        repoKey: key,
        agent,
        scope: a.mem.scope,
        path,
        bytes,
        origin: this.origin(reg),
      });
      return { ok: true, ...r };
    } catch (e) {
      return {
        ok: false,
        code: 'unavailable',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
