/**
 * Agent memory in the box (docs/agent-history-plan.md, Phase 4). ctl is the
 * edge on every provider, docker included: each agent's memory dir is on the
 * box's own disk (claude: `autoMemoryDirectory` in the baked managed settings).
 *
 *  - Seed once per box: `history.memory.seed` returns the hub's latest set for
 *    the box's repo (plus the host copy for paths the hub never saw); it is
 *    merged into the dir last-writer-wins (`mergeSeed`) and becomes the
 *    baseline. What the box wrote before the seed survives and ships.
 *  - Write-back: every pass, a file whose sha differs from the baseline ships as
 *    `history.memory.put` (or a tombstone when it is gone), and becomes the new
 *    baseline once the hub stored it.
 */
import { createHash } from 'node:crypto';
import {
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  MEMORY_STATE_FILE,
  createRedactor,
  safeMemoryPath,
  secretValuesFromEnv,
  type MemoryFileWire,
  type MemoryPutResult,
  type MemorySeedReply,
  type Redactor,
} from '@agentbox/core';
import { postRpcAwait, relayNotReady, type RelayRpcResult } from './relay-rpc.js';
import { resolveRelayEnv } from './relay-env.js';
import { currentBoxId } from './session-pointer.js';

const RPC_TIMEOUT_MS = 60_000;
const DISABLED_BACKOFF_MS = 10 * 60_000;

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

async function call(method: string, params: unknown): Promise<RelayRpcResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RelayRpcResult>((resolve) => {
    timer = setTimeout(() => resolve({ exitCode: 126, stdout: '', stderr: '' }), RPC_TIMEOUT_MS);
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
    if (relayNotReady(r)) return 'unreachable';
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
      return {
        ok: false,
        code: 'unavailable',
        message: `relay answered exit ${String(r.exitCode)}`,
      };
    }
    try {
      return JSON.parse(r.stdout) as MemoryPutResult;
    } catch {
      return { ok: false, code: 'unavailable', message: 'unparseable relay reply' };
    }
  },
};

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface MemoryScan {
  /** Files read (within the size and count caps). */
  files: Map<string, Buffer>;
  /**
   * Every regular file seen, read or not. Only a baseline path absent from
   * this is a deletion: a file over the cap or briefly unreadable still exists.
   */
  present: Set<string>;
  /** mtime (epoch ms) of every file in `present`. */
  mtimes: Map<string, number>;
}

/** Regular files under `dir` (no symlinks followed). */
export async function scanMemoryDir(dir: string): Promise<MemoryScan> {
  const out = new Map<string, Buffer>();
  const present = new Set<string>();
  const mtimes = new Map<string, number>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile() && safeMemoryPath(r)) {
        present.add(r);
        mtimes.set(r, st.mtimeMs);
        if (st.size > MEMORY_FILE_MAX_BYTES || out.size >= MEMORY_MAX_FILES) continue;
        const bytes = await readFile(p).catch(() => null);
        if (bytes) out.set(r, bytes);
      }
    }
  };
  await walk(dir, '');
  return { files: out, present, mtimes };
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

/** Write `files` into `dir` and remove `remove`; every other file is left alone. */
async function placeFiles(
  dir: string,
  files: Array<{ path: string; bytes: Buffer }>,
  remove: string[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const owner = await ownerOf(dir);
  for (const path of remove) await rm(join(dir, path), { force: true });
  for (const f of files) {
    const p = join(dir, f.path);
    const made = await mkdir(dirname(p), { recursive: true });
    // `made` is the first dir mkdir created: hand it and those below to the user.
    if (owner && made) {
      for (let d = dirname(p); d.length >= made.length; d = dirname(d)) {
        await chown(d, owner.uid, owner.gid).catch(() => undefined);
      }
    }
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

/**
 * Merge a seed into what the box already holds, last writer wins per file.
 * The box can hold files before its seed lands (the agent ran while the relay
 * was unreachable, or a checkpoint carried them), so the seed never wipes it:
 *
 *  - a box file the seed does not know is kept and left out of the baseline,
 *    so the next pass ships it as a new version;
 *  - a box file that differs from the hub's version and is newer than it is
 *    kept the same way (the baseline is the hub's sha, so it ships);
 *  - an older one is overwritten by the hub's version;
 *  - a hub tombstone newer than the box file deletes it; an older one does not.
 *
 * A seed version with no `updatedAt` (a host-only seed, an older hub) has no
 * time to compare against, so it wins over a differing box file as before.
 */
export async function mergeSeed(
  dir: string,
  seed: MemoryFileWire[],
): Promise<{ baseline: Record<string, string>; placed: number }> {
  const local = await scanMemoryDir(dir);
  const write: Array<{ path: string; bytes: Buffer }> = [];
  const remove: string[] = [];
  const baseline: Record<string, string> = {};
  for (const f of seed) {
    const p = safeMemoryPath(f.path);
    if (!p) continue;
    const mtime = local.mtimes.get(p);
    const boxNewer = mtime !== undefined && f.updatedAt !== undefined && mtime > f.updatedAt;
    if (f.deleted || f.content === undefined) {
      if (local.present.has(p) && !boxNewer) remove.push(p);
      continue;
    }
    const bytes = Buffer.from(f.content, 'base64');
    const digest = sha(bytes);
    baseline[p] = digest;
    const mine = local.files.get(p);
    if (mine && sha(mine) === digest) continue;
    // Present but unread (over the size cap): it is the box's, leave it.
    if (local.present.has(p) && (boxNewer || !mine)) continue;
    write.push({ path: p, bytes });
  }
  await placeFiles(dir, write, remove);
  return { baseline, placed: write.length };
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
  private unsupportedUntil = 0;
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

  /** The relay does not know the memory methods: stop the quick seed retries. */
  get backingOff(): boolean {
    return this.now() < this.unsupportedUntil;
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
        if (opts.noSeed || this.now() < this.unsupportedUntil) return stats;
        const reply = await this.rpc.seed();
        if (typeof reply === 'string') {
          stats.errors.push(`seed: relay ${reply}`);
          // An older relay will not learn the method in 5 s.
          if (reply === 'unsupported') this.unsupportedUntil = this.now() + DISABLED_BACKOFF_MS;
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
              files: Object.fromEntries([...local.files].map(([p, b]) => [p, sha(b)])),
            };
            continue;
          }
          const { baseline } = await mergeSeed(a.boxDir, a.files);
          next.agents[a.agent] = { boxDir: a.boxDir, files: baseline };
          stats.seeded.push(`${a.agent}:${String(Object.keys(baseline).length)}`);
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
        for (const [p, b] of local.files) {
          if (a.files[p] !== sha(b)) changes.push({ path: p, bytes: b });
        }
        for (const p of Object.keys(a.files)) {
          if (!local.present.has(p)) changes.push({ path: p, bytes: null });
        }
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
    private readonly opts: {
      intervalMs?: number;
      log?: (line: string) => void;
      sync?: MemorySync;
    } = {},
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
    const settled = this.sync.seeded || this.sync.backingOff;
    this.schedule(settled ? (this.opts.intervalMs ?? 15_000) : 5_000);
    return stats;
  }
}
