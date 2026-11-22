/**
 * Agent memory in the box (docs/agent-history-plan.md, Phase 4). ctl is the
 * edge on every provider, docker included: each agent's memory dir is on the
 * box's own disk (claude: `autoMemoryDirectory` in the baked managed settings).
 *
 *  - Seed once per box: `history.memory.seed` returns the hub's latest set for
 *    the box's repo (plus the host copy for paths the hub never saw); it
 *    replaces the dir and becomes the baseline.
 *  - Write-back: every pass, a file whose sha differs from the baseline ships as
 *    `history.memory.put` (or a tombstone when it is gone), and becomes the new
 *    baseline once the hub stored it.
 */
import { createHash } from 'node:crypto';
import { chown, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  MEMORY_STATE_FILE,
  createRedactor,
  safeMemoryPath,
  secretValuesFromEnv,
  type MemoryPutResult,
  type MemorySeedReply,
  type Redactor,
} from '@agentbox/core';
import { postRpcAwait } from './relay-rpc.js';
import { resolveRelayEnv } from './relay-env.js';
import { currentBoxId } from './session-pointer.js';

const RPC_TIMEOUT_MS = 60_000;
const DISABLED_BACKOFF_MS = 10 * 60_000;
/** postRpcAwait's own codes for a missing relay env (65) and a transport failure (126). */
const UNREACHABLE_EXIT = new Set([65, 126]);

export interface MemoryState {
  version: 1;
  /** The box that wrote it: a state carried over by a checkpoint is not ours. */
  boxId: string;
  agents: Record<string, { boxDir: string; files: Record<string, string> }>;
}

export interface MemoryRpc {
  seed(): Promise<MemorySeedReply | 'unreachable' | 'unsupported'>;
  put(params: {
    agent: string;
    path: string;
    content?: string;
    deleted?: boolean;
  }): Promise<MemoryPutResult>;
}

async function call(method: string, params: unknown): Promise<{ exitCode: number; stdout: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ exitCode: number; stdout: string }>((resolve) => {
    timer = setTimeout(() => resolve({ exitCode: 126, stdout: '' }), RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([postRpcAwait(method, params, { quiet: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const relayMemoryRpc: MemoryRpc = {
  async seed() {
    const r = await call('history.memory.seed', {});
    if (UNREACHABLE_EXIT.has(r.exitCode)) return 'unreachable';
    if (r.exitCode !== 0) return 'unsupported';
    try {
      const v = JSON.parse(r.stdout) as Partial<MemorySeedReply>;
      if (!Array.isArray(v.agents) || typeof v.writeBack !== 'boolean') return 'unsupported';
      return v as MemorySeedReply;
    } catch {
      return 'unsupported';
    }
  },
  async put(params) {
    const r = await call('history.memory.put', params);
    if (r.exitCode !== 0) {
      return { ok: false, code: 'unavailable', message: `relay answered exit ${String(r.exitCode)}` };
    }
    try {
      return JSON.parse(r.stdout) as MemoryPutResult;
    } catch {
      return { ok: false, code: 'unavailable', message: 'unparseable relay reply' };
    }
  },
};

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Regular files under `dir` (no symlinks followed) → sha256, plus their bytes. */
export async function scanMemoryDir(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.size >= MEMORY_MAX_FILES) return;
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile() && st.size <= MEMORY_FILE_MAX_BYTES && safeMemoryPath(r)) {
        const bytes = await readFile(p).catch(() => null);
        if (bytes) out.set(r, bytes);
      }
    }
  };
  await walk(dir, '');
  return out;
}

/** ctl may run as root; the files belong to the box user (owner of the home dir). */
async function ownerOf(dir: string): Promise<{ uid: number; gid: number } | null> {
  if (process.getuid?.() !== 0) return null;
  for (let d = dir; d !== '/' && d !== '.'; d = dirname(d)) {
    const st = await stat(d).catch(() => null);
    if (st && st.uid !== 0) return { uid: st.uid, gid: st.gid };
  }
  return null;
}

/** Make `dir` hold exactly `files`. */
async function placeSet(dir: string, files: Array<{ path: string; bytes: Buffer }>): Promise<void> {
  await mkdir(dir, { recursive: true });
  const owner = await ownerOf(dir);
  const keep = new Set(files.map((f) => f.path));
  for (const path of (await scanMemoryDir(dir)).keys()) {
    if (!keep.has(path)) await rm(join(dir, path), { force: true });
  }
  for (const f of files) {
    const p = join(dir, f.path);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.agentbox-tmp`;
    await writeFile(tmp, f.bytes);
    await rename(tmp, p);
    if (owner) await chown(p, owner.uid, owner.gid).catch(() => undefined);
  }
  if (owner) {
    for (let d = dir; d.startsWith('/home/') && d.split('/').length > 3; d = dirname(d)) {
      await chown(d, owner.uid, owner.gid).catch(() => undefined);
    }
  }
}

export interface MemoryPassStats {
  seeded: string[];
  shipped: number;
  errors: string[];
}

export class MemorySync {
  private state: MemoryState | null = null;
  private writeBack = false;
  private disabledUntil = 0;
  private redactor: Redactor | null = null;

  constructor(
    private readonly opts: {
      rpc?: MemoryRpc;
      statePath?: string;
      boxId?: string;
      now?: () => number;
    } = {},
  ) {}

  private get rpc(): MemoryRpc {
    return this.opts.rpc ?? relayMemoryRpc;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private boxId(): string {
    return this.opts.boxId ?? currentBoxId() ?? '';
  }

  private async loadState(): Promise<MemoryState | null> {
    try {
      const s = JSON.parse(
        await readFile(this.opts.statePath ?? MEMORY_STATE_FILE, 'utf8'),
      ) as MemoryState;
      return s.version === 1 && s.boxId === this.boxId() && s.agents ? s : null;
    } catch {
      return null;
    }
  }

  private async saveState(): Promise<void> {
    const p = this.opts.statePath ?? MEMORY_STATE_FILE;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(`${p}.tmp`, JSON.stringify(this.state));
    await rename(`${p}.tmp`, p);
  }

  /** True once this box has been seeded (state on disk). */
  get seeded(): boolean {
    return this.state !== null;
  }

  private box(): Redactor {
    if (!this.redactor) {
      const secrets = secretValuesFromEnv(process.env);
      const { token } = resolveRelayEnv();
      if (token) secrets.push(token);
      this.redactor = createRedactor({ secrets });
    }
    return this.redactor;
  }

  /**
   * One pass: seed if this box never was, else ship what changed. Never throws.
   * `noSeed` (a destroy's flush) never replaces the dir: an unseeded box keeps
   * what it holds.
   */
  async pass(opts: { noSeed?: boolean } = {}): Promise<MemoryPassStats> {
    const stats: MemoryPassStats = { seeded: [], shipped: 0, errors: [] };
    try {
      this.state ??= await this.loadState();
      if (!this.state) {
        if (opts.noSeed) return stats;
        const reply = await this.rpc.seed();
        if (typeof reply === 'string') {
          stats.errors.push(`seed: relay ${reply}`);
          return stats;
        }
        const next: MemoryState = { version: 1, boxId: this.boxId(), agents: {} };
        for (const a of reply.agents) {
          if (!a.boxDir.startsWith('/')) continue;
          if (a.files === null) {
            // Nothing known anywhere: what the box holds is the baseline.
            const local = await scanMemoryDir(a.boxDir);
            next.agents[a.agent] = {
              boxDir: a.boxDir,
              files: Object.fromEntries([...local].map(([p, b]) => [p, sha(b)])),
            };
            continue;
          }
          const files = a.files.flatMap((f) => {
            const p = safeMemoryPath(f.path);
            return p && f.content !== undefined
              ? [{ path: p, bytes: Buffer.from(f.content, 'base64') }]
              : [];
          });
          await placeSet(a.boxDir, files);
          next.agents[a.agent] = {
            boxDir: a.boxDir,
            files: Object.fromEntries(files.map((f) => [f.path, sha(f.bytes)])),
          };
          stats.seeded.push(`${a.agent}:${String(files.length)}`);
        }
        this.state = next;
        this.writeBack = reply.writeBack;
        if (!reply.writeBack) this.disabledUntil = this.now() + DISABLED_BACKOFF_MS;
        await this.saveState();
        return stats;
      }
      // A restarted daemon does not know whether write-back is on; it finds out
      // from the first put.
      if (!this.writeBack && this.now() < this.disabledUntil) return stats;
      for (const [agent, a] of Object.entries(this.state.agents)) {
        const local = await scanMemoryDir(a.boxDir);
        const changes: Array<{ path: string; bytes: Buffer | null }> = [];
        for (const [p, b] of local) if (a.files[p] !== sha(b)) changes.push({ path: p, bytes: b });
        for (const p of Object.keys(a.files)) if (!local.has(p)) changes.push({ path: p, bytes: null });
        for (const c of changes) {
          const r = await this.rpc.put({
            agent,
            path: c.path,
            ...(c.bytes
              ? { content: Buffer.from(this.box().redact(c.bytes).bytes).toString('base64') }
              : { deleted: true }),
          });
          if (!r.ok) {
            stats.errors.push(`${c.path}: ${r.code}: ${r.message}`);
            if (r.code === 'disabled') {
              this.writeBack = false;
              this.disabledUntil = this.now() + DISABLED_BACKOFF_MS;
              return stats;
            }
            if (r.code === 'unavailable') return stats;
            continue;
          }
          this.writeBack = true;
          if (c.bytes) a.files[c.path] = sha(c.bytes);
          else delete a.files[c.path];
          stats.shipped++;
          await this.saveState();
        }
      }
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
    return stats;
  }
}

/** The daemon's loop: quick retries until seeded, then a pass every `intervalMs`. */
export class MemoryLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  readonly sync: MemorySync;

  constructor(
    private readonly opts: { intervalMs?: number; log?: (line: string) => void; sync?: MemorySync } = {},
  ) {
    this.sync = opts.sync ?? new MemorySync();
  }

  start(firstDelayMs = 1_000): void {
    this.schedule(firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  async tick(): Promise<MemoryPassStats> {
    const stats = await this.sync.pass();
    if (stats.seeded.length > 0) this.opts.log?.(`memory: seeded ${stats.seeded.join(', ')}`);
    for (const e of stats.errors) this.opts.log?.(`memory: ${e}`);
    this.schedule(this.sync.seeded ? (this.opts.intervalMs ?? 15_000) : 5_000);
    return stats;
  }
}
