/**
 * Codex CLI session teleport. Codex stores sessions at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, flat across
 * all projects. The cwd lives inside the first line's `session_meta.payload.cwd`
 * field, so:
 *   - `-c` filters by `payload.cwd === hostCwd`, sorts by mtime, picks newest.
 *   - `--resume <uuid>` globs for `*<uuid>.jsonl` and warns if cwd mismatches.
 *
 * Resume tokens forward to `codex resume <id>` (the subcommand form Codex
 * actually uses — not `--resume <id>`).
 */

import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_WORKSPACE } from './cwd-encoding.js';
import { TeleportError, type ResolvedTeleport, type ResumeMode, type TeleportLogger } from './types.js';

interface CodexResolveOptions {
  hostCwd: string;
  mode: ResumeMode;
  hostHome?: string;
  log?: TeleportLogger;
}

interface CodexSessionFile {
  hostPath: string;
  /** Relative to `~/.codex/sessions/` — preserved when uploading into the box. */
  relPath: string;
  uuid: string;
  cwd: string | null;
  mtimeMs: number;
}

export async function resolveCodexTeleport(
  opts: CodexResolveOptions,
): Promise<ResolvedTeleport> {
  const hostHome = opts.hostHome ?? homedir();
  const sessionsRoot = join(hostHome, '.codex', 'sessions');

  if (!existsSync(sessionsRoot)) {
    throw new TeleportError(
      `no Codex session history found on the host (expected at ${sessionsRoot}). Run \`codex\` at least once before using -c / --resume.`,
    );
  }

  const all = await listCodexSessions(sessionsRoot);
  if (all.length === 0) {
    throw new TeleportError(
      `no Codex sessions found in ${sessionsRoot}. Run \`codex\` here at least once first.`,
    );
  }

  let picked: CodexSessionFile;
  if (opts.mode.kind === 'resume') {
    // Alias to a local const so the narrowed type survives into the
    // `.filter` callback. TS can't keep narrowing on a property access
    // (`opts.mode`) across closures because the property could in principle
    // be mutated between the check and each callback invocation.
    const mode = opts.mode;
    const matches = all.filter((s) => s.uuid === mode.id || s.uuid.startsWith(mode.id));
    if (matches.length === 0) {
      throw new TeleportError(
        `Codex session "${mode.id}" not found under ${sessionsRoot}.`,
      );
    }
    if (matches.length > 1) {
      throw new TeleportError(
        `Codex session id "${mode.id}" matched multiple files; pass the full uuid.`,
      );
    }
    picked = matches[0]!;
    if (picked.cwd !== null && picked.cwd !== opts.hostCwd) {
      opts.log?.(
        `teleport: WARN codex session ${picked.uuid} was recorded at ${picked.cwd}, not ${opts.hostCwd}; rewriting cwd anyway`,
      );
    }
  } else {
    const matching = all.filter((s) => s.cwd === opts.hostCwd);
    if (matching.length === 0) {
      throw new TeleportError(
        `no Codex session found whose cwd matches ${opts.hostCwd}. Run \`codex\` here first, or pass --resume <id> explicitly.`,
      );
    }
    matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
    picked = matching[0]!;
  }

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-teleport-codex-'));
  const stagedFile = join(stage, posixBasename(picked.relPath));
  await rewriteCodexSession(picked.hostPath, stagedFile, opts.hostCwd);
  opts.log?.(`teleport: codex session ${picked.uuid} staged for upload`);

  const boxParentDir = `/home/vscode/.codex/sessions/${posixDirname(picked.relPath)}`;

  return {
    agent: 'codex',
    sessionId: picked.uuid,
    hostFile: stagedFile,
    boxPath: `${boxParentDir}/${posixBasename(picked.relPath)}`,
    boxParentDir,
    forwardArgs: ['resume', picked.uuid],
  };
}

function posixBasename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}

async function listCodexSessions(sessionsRoot: string): Promise<CodexSessionFile[]> {
  const out: CodexSessionFile[] = [];
  // Sessions live three levels deep: YYYY/MM/DD/rollout-*.jsonl. Walk that
  // depth explicitly — no recursive scan, no globbing dependency.
  const years = await safeReaddir(sessionsRoot);
  for (const y of years) {
    if (!/^\d{4}$/u.test(y)) continue;
    const yDir = join(sessionsRoot, y);
    const months = await safeReaddir(yDir);
    for (const m of months) {
      if (!/^\d{2}$/u.test(m)) continue;
      const mDir = join(yDir, m);
      const days = await safeReaddir(mDir);
      for (const d of days) {
        if (!/^\d{2}$/u.test(d)) continue;
        const dDir = join(mDir, d);
        const files = await safeReaddir(dDir);
        for (const name of files) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const uuid = extractCodexUuid(name);
          if (uuid === null) continue;
          const hostPath = join(dDir, name);
          let mtimeMs = 0;
          try {
            mtimeMs = (await stat(hostPath)).mtimeMs;
          } catch {
            continue;
          }
          const cwd = await peekCodexCwd(hostPath);
          out.push({
            hostPath,
            relPath: `${y}/${m}/${d}/${name}`,
            uuid,
            cwd,
            mtimeMs,
          });
        }
      }
    }
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function extractCodexUuid(filename: string): string | null {
  // `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` — the uuid is the trailing
  // 36-char dashed hex segment. Match it explicitly so we don't pick up the
  // date-time prefix.
  const m = filename.match(
    /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/u,
  );
  return m ? m[1]! : null;
}

async function peekCodexCwd(file: string): Promise<string | null> {
  // First line is the session_meta record with payload.cwd. Read just enough
  // bytes to capture it — the rest of the file is potentially huge.
  let firstLine: string;
  try {
    const buf = await readFile(file, 'utf8');
    const nl = buf.indexOf('\n');
    firstLine = nl === -1 ? buf : buf.slice(0, nl);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { cwd?: string };
    };
    if (parsed.type === 'session_meta' && typeof parsed.payload?.cwd === 'string') {
      return parsed.payload.cwd;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Record types whose payloads hold only config/paths (no freeform transcript),
 *  so a deep host-path rewrite is safe. `response_item` / `event_msg` are the
 *  conversation + tool output and must be left byte-for-byte intact. Codex
 *  records the cwd in `session_meta.payload.cwd` AND in every per-turn
 *  `turn_context.payload` (cwd, workspace_roots, sandbox-policy entry paths) —
 *  the latest `turn_context.cwd` is the "latest recorded cwd" that drives the
 *  "Choose working directory" resume prompt, so both must be rewritten. */
const CWD_REWRITE_TYPES = new Set(['session_meta', 'turn_context']);

/** Replace a value that *is* hostCwd (or sits under hostCwd/) with BOX_WORKSPACE,
 *  preserving the suffix. The trailing-'/' boundary stops a sibling dir
 *  (".../repo-gh-2") from matching ".../repo-gh". */
function rewriteHostPath(s: string, hostCwd: string): string {
  if (s === hostCwd) return BOX_WORKSPACE;
  if (s.startsWith(hostCwd + '/')) return BOX_WORKSPACE + s.slice(hostCwd.length);
  return s;
}

/** Deep-rewrite every host-path string inside a config-only meta payload. Only
 *  whole-string paths under hostCwd are touched, so a non-path blob like
 *  `session_meta.payload.base_instructions.text` (the system prompt) is left
 *  unchanged, and any new path field Codex adds is covered automatically. */
function deepRewriteHostPaths(value: unknown, hostCwd: string): unknown {
  if (typeof value === 'string') return rewriteHostPath(value, hostCwd);
  if (Array.isArray(value)) return value.map((v) => deepRewriteHostPaths(v, hostCwd));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = deepRewriteHostPaths(o[k], hostCwd);
    return o;
  }
  return value;
}

async function rewriteCodexSession(
  src: string,
  dst: string,
  hostCwd: string,
): Promise<void> {
  const raw = await readFile(src, 'utf8');
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { type?: unknown; payload?: unknown };
      if (
        typeof obj.type === 'string' &&
        CWD_REWRITE_TYPES.has(obj.type) &&
        obj.payload &&
        typeof obj.payload === 'object' &&
        !Array.isArray(obj.payload)
      ) {
        obj.payload = deepRewriteHostPaths(obj.payload, hostCwd);
        out.push(JSON.stringify(obj));
        continue;
      }
    }
    out.push(line);
  }
  await writeFile(dst, out.join('\n'), 'utf8');
}
