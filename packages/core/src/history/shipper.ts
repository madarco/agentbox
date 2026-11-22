import { createHash, type Hash } from 'node:crypto';
import type { Redactor } from './redact.js';
import type {
  AgentHistorySpec,
  HistoryBinding,
  HistoryFrame,
  HistoryIngestSink,
  HistoryOrigin,
} from './types.js';

/**
 * The tailer both edges run: the host relay over `docker exec` for docker boxes,
 * `agentbox-ctl` over the local disk everywhere else. It ships the sessions the
 * box's binding log names and nothing else, so a shared docker volume never
 * leaks another box's session into this one's history.
 *
 * The hub is the durable cursor: an edge starts at 0, the hub answers
 * `offset_mismatch` with what it holds, and the engine fast-forwards after
 * verifying the prefix hash against its own file (or re-ships from 0 when the
 * file was rewritten). Nothing is persisted at the edge.
 */

export interface HistoryFileSource {
  /** The box's binding log, oldest first. */
  readBindings(): Promise<HistoryBinding[]>;
  /** File size in bytes, or null when absent. Absolute paths. */
  size(path: string): Promise<number | null>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Basenames in a directory, or null when absent. */
  list(dir: string): Promise<string[] | null>;
}

export interface ShippedAgent {
  agent: string;
  /** Absolute config dir in the box (`/home/vscode/.claude`). */
  configDir: string;
  /** The agent's project key in the box (`-workspace`). */
  projectKey: string;
  spec: AgentHistorySpec;
}

export interface HistoryShipperOptions {
  origin: HistoryOrigin;
  agents: ShippedAgent[];
  source: HistoryFileSource;
  sink: HistoryIngestSink;
  redactor: Redactor;
  /** Largest frame payload (raw bytes). */
  frameMax: number;
  /** How much one read pulls from a file. */
  readMax?: number;
  /** Per-file byte budget per pass, so one huge backlog cannot starve the rest. */
  passBudget?: number;
}

export interface ShipStats {
  files: number;
  frames: number;
  bytes: number;
  redactions: number;
  errors: string[];
  disabled?: boolean;
}

interface Cursor {
  offset: number;
  hash: Hash;
  reset: boolean;
}

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/;
const NEWLINE = 0x0a;
const DEFAULT_READ_MAX = 8 * 1024 * 1024;
const LONG_LINE_MAX = 64 * 1024 * 1024;
const DEFAULT_PASS_BUDGET = 64 * 1024 * 1024;

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${esc}$`);
}

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

/** Absolute path → agent-relative path for every file a binding names. */
export async function resolveSessionFiles(
  source: HistoryFileSource,
  agent: ShippedAgent,
  sessionId: string,
): Promise<Array<{ abs: string; rel: string }>> {
  if (!SESSION_ID.test(sessionId)) return [];
  const out: Array<{ abs: string; rel: string }> = [];
  for (const t of agent.spec.transcripts) {
    if (t.mode !== 'append') continue;
    const root = t.root.replace(/<projectKey>/g, agent.projectKey);
    for (const pattern of t.sessionFiles) {
      const relPattern = posixJoin(root, pattern.replace(/<sessionId>/g, sessionId));
      const slash = relPattern.lastIndexOf('/');
      const dirRel = slash === -1 ? '' : relPattern.slice(0, slash);
      const base = relPattern.slice(slash + 1);
      if (dirRel.includes('*')) continue;
      if (!base.includes('*')) {
        out.push({ abs: posixJoin(agent.configDir, relPattern), rel: relPattern });
        continue;
      }
      const names = await source.list(posixJoin(agent.configDir, dirRel));
      const re = globToRegExp(base);
      for (const n of (names ?? []).sort()) {
        if (re.test(n)) {
          const rel = posixJoin(dirRel, n);
          out.push({ abs: posixJoin(agent.configDir, rel), rel });
        }
      }
    }
  }
  return out;
}

export class HistoryShipper {
  private readonly cursors = new Map<string, Cursor>();
  private disabled = false;
  private running: Promise<ShipStats> | null = null;

  constructor(private readonly opts: HistoryShipperOptions) {}

  get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Ship every bound session's complete lines. `final` also ships a trailing
   * partial line — the box is going away and nothing will complete it.
   * Serialized: a pass that starts while one runs waits for it, then runs.
   */
  async pass(opts: { final?: boolean } = {}): Promise<ShipStats> {
    while (this.running) await this.running.catch(() => undefined);
    const run = this.doPass(opts.final === true);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }

  private async doPass(final: boolean): Promise<ShipStats> {
    const stats: ShipStats = { files: 0, frames: 0, bytes: 0, redactions: 0, errors: [] };
    if (this.disabled) return { ...stats, disabled: true };
    let bindings: HistoryBinding[];
    try {
      bindings = await this.opts.source.readBindings();
    } catch (e) {
      stats.errors.push(`bindings: ${e instanceof Error ? e.message : String(e)}`);
      return stats;
    }
    const seen = new Set<string>();
    for (const b of bindings) {
      const agent = this.opts.agents.find((a) => a.agent === b.agent);
      if (!agent) continue;
      const key = `${b.agent}\0${b.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let files: Array<{ abs: string; rel: string }>;
      try {
        files = await resolveSessionFiles(this.opts.source, agent, b.sessionId);
      } catch (e) {
        stats.errors.push(`${b.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const f of files) {
        await this.shipFile(agent.agent, f.abs, f.rel, final, stats);
        if (this.disabled) return { ...stats, disabled: true };
      }
    }
    return stats;
  }

  private async shipFile(
    agent: string,
    abs: string,
    rel: string,
    final: boolean,
    stats: ShipStats,
  ): Promise<void> {
    const { source, redactor, frameMax } = this.opts;
    const readMax = this.opts.readMax ?? DEFAULT_READ_MAX;
    let budget = this.opts.passBudget ?? DEFAULT_PASS_BUDGET;
    const size = await source.size(abs).catch(() => null);
    if (size === null) return;
    const key = `${agent}\0${rel}`;
    let cur = this.cursors.get(key);
    if (!cur || size < cur.offset) {
      // New to this edge, or shrunk (rewritten): start over. A known file that
      // shrank is a new generation at the hub.
      cur = { offset: 0, hash: createHash('sha256'), reset: cur !== undefined };
      this.cursors.set(key, cur);
    }
    if (size > cur.offset) stats.files++;
    let want = readMax;
    let resyncs = 0;
    outer: while (size > cur.offset && budget > 0) {
      const len = Math.min(size - cur.offset, want);
      const buf = Buffer.from(await source.read(abs, cur.offset, len));
      if (buf.length === 0) return;
      let end = buf.lastIndexOf(NEWLINE) + 1;
      if (end === 0) {
        const atEof = cur.offset + buf.length >= size;
        if (atEof && !final) return; // a line still being written
        if (!atEof && want < LONG_LINE_MAX) {
          want *= 2; // one line longer than a read: widen and retry
          continue;
        }
        end = buf.length;
      }
      if (final && cur.offset + buf.length >= size) end = buf.length;
      const region = buf.subarray(0, end);
      const red = redactor.redact(region);
      stats.redactions += red.hits;
      const redacted = Buffer.from(red.bytes);
      // Frames end on line boundaries when a line fits, so the host relay's
      // second (exact-value) redaction pass sees whole lines.
      let pos = 0;
      while (pos < region.length) {
        let stop = Math.min(region.length, pos + frameMax);
        if (stop < region.length) {
          const nl = region.lastIndexOf(NEWLINE, stop - 1);
          if (nl >= pos) stop = nl + 1;
        }
        const raw = region.subarray(pos, stop);
        const r = await this.sendFrame(
          agent,
          abs,
          rel,
          cur,
          raw,
          redacted.subarray(pos, stop),
          stats,
        );
        if (r === 'stop') return;
        if (r === 'resynced') {
          if (++resyncs > 2) return;
          continue outer;
        }
        pos = stop;
        budget -= raw.length;
      }
      want = readMax;
    }
  }

  /** One frame: accepted (cursor moved), stop this file, or cursor moved by a resync. */
  private async sendFrame(
    agent: string,
    abs: string,
    rel: string,
    cur: Cursor,
    raw: Buffer,
    redacted: Buffer,
    stats: ShipStats,
  ): Promise<'ok' | 'stop' | 'resynced'> {
    const prefix = cur.offset === 0 ? '' : cur.hash.copy().digest('hex');
    const after = cur.hash.copy().update(raw).digest('hex');
    const frame: HistoryFrame = {
      origin: this.opts.origin,
      agent,
      path: rel,
      offset: cur.offset,
      sha256Prefix: prefix,
      sha256: after,
      data: redacted.toString('base64'),
      ...(cur.reset && cur.offset === 0 ? { reset: true } : {}),
    };
    let res;
    try {
      res = await this.opts.sink.ingest(frame);
    } catch (e) {
      stats.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      return 'stop';
    }
    if (res.ok) {
      cur.hash.update(raw);
      cur.offset += raw.length;
      cur.reset = false;
      stats.frames++;
      stats.bytes += raw.length;
      return 'ok';
    }
    if (res.code === 'disabled') {
      this.disabled = true;
      return 'stop';
    }
    if (res.code !== 'offset_mismatch') {
      stats.errors.push(`${rel}: ${res.code}: ${res.message}`);
      return 'stop';
    }
    await this.resync(abs, cur, res.offset ?? 0, res.sha256 ?? '');
    return 'resynced';
  }

  /** The hub holds `offset` bytes hashing to `sha`: adopt them if our file agrees. */
  private async resync(abs: string, cur: Cursor, offset: number, sha: string): Promise<void> {
    const size = await this.opts.source.size(abs).catch(() => null);
    if (offset === 0 || size === null || offset > size) {
      cur.offset = 0;
      cur.hash = createHash('sha256');
      cur.reset = offset !== 0;
      return;
    }
    const h = createHash('sha256');
    const step = this.opts.readMax ?? DEFAULT_READ_MAX;
    for (let at = 0; at < offset; at += step) {
      h.update(await this.opts.source.read(abs, at, Math.min(step, offset - at)));
    }
    if (h.copy().digest('hex') === sha) {
      cur.offset = offset;
      cur.hash = h;
      cur.reset = false;
    } else {
      cur.offset = 0;
      cur.hash = createHash('sha256');
      cur.reset = true;
    }
  }
}
