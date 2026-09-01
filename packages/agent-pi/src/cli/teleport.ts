/**
 * Pi CLI session teleport.
 *
 * Pi stores sessions at
 * `~/.pi/agent/sessions/<slugified-cwd>/<ISO>_<uuid>.jsonl`, and the FIRST line
 * of each file is a `session` record carrying the working directory:
 *
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"<abs>"}
 *
 * That record is the only place a host path appears in a real session (verified
 * by walking every string of a live transcript: `message`, `model_change` and
 * `thinking_level_change` records carry none), so the rewrite is one field
 * rather than codex's deep walk over config-only payloads.
 *
 * The slug directory is deliberately NOT parsed. It is a Pi implementation
 * detail, and line 1's `cwd` is authoritative — so we glob the slug dirs and
 * read the header, exactly as the codex resolver reads `payload.cwd`.
 *
 * Resume forwards `--session <absolute box path>` rather than the uuid.
 * `--session` accepts a path *or* a partial id (`pi --help`), and passing the
 * path means the file can land in a flat drop directory instead of the box's
 * own slug dir — so nothing here has to reproduce Pi's slugging. Verified
 * live: `pi --session /abs/out-of-tree.jsonl` from an unrelated cwd loads the
 * transcript and appends to it, keeping the session id.
 */

import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOX_WORKSPACE,
  TeleportError,
  type ResolvedTeleport,
  type ResumeMode,
  type TeleportLogger,
} from '@agentbox/cli-kit';

/**
 * Flat drop directory inside the box. Pi indexes sessions by cwd for its own
 * pickers, but `--session <path>` bypasses that index entirely, so the file
 * does not need to sit in the `/workspace` slug dir.
 */
const BOX_SESSIONS_DIR = '/home/vscode/.pi/agent/sessions';

interface PiSessionFile {
  hostPath: string;
  fileName: string;
  uuid: string;
  cwd: string | null;
  mtimeMs: number;
}

interface PiResolveOptions {
  hostCwd: string;
  mode: ResumeMode;
  hostHome?: string;
  log?: TeleportLogger;
}

export async function resolvePiTeleport(opts: PiResolveOptions): Promise<ResolvedTeleport> {
  const hostHome = opts.hostHome ?? homedir();
  const sessionsRoot = join(hostHome, '.pi', 'agent', 'sessions');

  if (!existsSync(sessionsRoot)) {
    throw new TeleportError(
      `no Pi session history found on the host (expected at ${sessionsRoot}). Run \`pi\` at least once before using -c / --resume.`,
    );
  }

  const all = await listPiSessions(sessionsRoot);
  if (all.length === 0) {
    throw new TeleportError(
      `no Pi sessions found in ${sessionsRoot}. Run \`pi\` here at least once first.`,
    );
  }

  let picked: PiSessionFile;
  if (opts.mode.kind === 'resume') {
    // Aliased so the narrowing survives into the filter callback.
    const mode = opts.mode;
    const matches = all.filter((s) => s.uuid === mode.id || s.uuid.startsWith(mode.id));
    if (matches.length === 0) {
      throw new TeleportError(`Pi session "${mode.id}" not found under ${sessionsRoot}.`);
    }
    if (matches.length > 1) {
      throw new TeleportError(
        `Pi session id "${mode.id}" matched multiple files; pass the full uuid.`,
      );
    }
    picked = matches[0]!;
    if (picked.cwd !== null && picked.cwd !== opts.hostCwd) {
      opts.log?.(
        `teleport: WARN pi session ${picked.uuid} was recorded at ${picked.cwd}, not ${opts.hostCwd}; rewriting cwd anyway`,
      );
    }
  } else {
    const matching = all.filter((s) => s.cwd === opts.hostCwd);
    if (matching.length === 0) {
      throw new TeleportError(
        `no Pi session found whose cwd matches ${opts.hostCwd}. Run \`pi\` here first, or pass --resume <id> explicitly.`,
      );
    }
    matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
    picked = matching[0]!;
  }

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-teleport-pi-'));
  const stagedFile = join(stage, picked.fileName);
  await rewritePiSession(picked.hostPath, stagedFile);
  opts.log?.(`teleport: pi session ${picked.uuid} staged for upload`);

  return {
    agent: 'pi',
    sessionId: picked.uuid,
    hostFile: stagedFile,
    boxPath: `${BOX_SESSIONS_DIR}/${picked.fileName}`,
    boxParentDir: BOX_SESSIONS_DIR,
    forwardArgs: ['--session', `${BOX_SESSIONS_DIR}/${picked.fileName}`],
  };
}

async function listPiSessions(sessionsRoot: string): Promise<PiSessionFile[]> {
  const out: PiSessionFile[] = [];
  // One level of slug dirs, then the `.jsonl` files. No recursive scan and no
  // assumption about how the slug is spelled.
  for (const slug of await safeReaddir(sessionsRoot)) {
    const dir = join(sessionsRoot, slug);
    for (const name of await safeReaddir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const hostPath = join(dir, name);
      let mtimeMs = 0;
      try {
        const st = await stat(hostPath);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const header = await peekPiHeader(hostPath);
      // The uuid comes from the header rather than the filename: the filename
      // is `<ISO>_<uuid>.jsonl`, but the record is the authority and a file Pi
      // renames still resolves.
      if (header === null || header.id === null) continue;
      out.push({ hostPath, fileName: name, uuid: header.id, cwd: header.cwd, mtimeMs });
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

/** Read line 1's `session` record. Returns null when it is missing or unparsable. */
async function peekPiHeader(
  file: string,
): Promise<{ id: string | null; cwd: string | null } | null> {
  let firstLine: string;
  try {
    const buf = await readFile(file, 'utf8');
    const nl = buf.indexOf('\n');
    firstLine = nl === -1 ? buf : buf.slice(0, nl);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string };
    if (parsed.type !== 'session') return null;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
    };
  } catch {
    return null;
  }
}

/**
 * Copy the session with the header's `cwd` repointed at `/workspace`.
 *
 * ONLY the `session` record is touched, and only its own `cwd` field. Every
 * other line is the conversation and is written back byte-for-byte — rewriting
 * inside a transcript would silently edit what the user (or the model) said.
 */
async function rewritePiSession(src: string, dst: string): Promise<void> {
  const raw = await readFile(src, 'utf8');
  const lines = raw.split('\n');
  const out: string[] = [];
  let headerDone = false;
  for (const line of lines) {
    if (headerDone || line.length === 0) {
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
      const obj = parsed as { type?: unknown; cwd?: unknown };
      if (obj.type === 'session') {
        // UNCONDITIONAL, not a prefix rewrite. The box's working directory is
        // `/workspace` whatever directory the session was recorded in, and
        // `--resume <id>` explicitly allows picking a session from ELSEWHERE
        // (we warn and continue). A `hostCwd`-anchored replacement silently
        // does nothing for exactly that case, so the teleported session landed
        // in the box still pointing at a host path that does not exist there --
        // while the log claimed it had been rewritten.
        if (typeof obj.cwd === 'string') obj.cwd = BOX_WORKSPACE;
        out.push(JSON.stringify(obj));
        headerDone = true;
        continue;
      }
    }
    out.push(line);
  }
  await writeFile(dst, out.join('\n'), 'utf8');
}
