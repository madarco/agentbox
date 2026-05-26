/**
 * Claude Code session teleport. Finds a host session JSONL under
 * `~/.claude/projects/<encoded host cwd>/<id>.jsonl`, rewrites each line's
 * top-level `cwd` field to `/workspace`, and writes the result to a host tmp
 * file ready for upload into the box's `/home/vscode/.claude/projects/-workspace/`.
 *
 * Claude session files are line-delimited JSON. We parse each line, swap
 * `cwd` if present, and re-serialize. Lines that don't parse cleanly are
 * forwarded verbatim — the file may contain forward-compatible variants we
 * don't recognize and shouldn't drop.
 */

import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_WORKSPACE, BOX_WORKSPACE_ENCODED, encodeClaudeProjectsDir } from './cwd-encoding.js';
import { TeleportError, type ResolvedTeleport, type ResumeMode, type TeleportLogger } from './types.js';

/** In-box `~/.claude/projects/-workspace/` directory. */
export const BOX_CLAUDE_PROJECTS_DIR = `/home/vscode/.claude/projects/${BOX_WORKSPACE_ENCODED}`;

interface ClaudeResolveOptions {
  hostCwd: string;
  mode: ResumeMode;
  /** Override for tests. */
  hostHome?: string;
  log?: TeleportLogger;
}

export async function resolveClaudeTeleport(
  opts: ClaudeResolveOptions,
): Promise<ResolvedTeleport> {
  const hostHome = opts.hostHome ?? homedir();
  const projectDir = join(
    hostHome,
    '.claude',
    'projects',
    encodeClaudeProjectsDir(opts.hostCwd),
  );

  if (!existsSync(projectDir)) {
    throw new TeleportError(
      `no Claude session history found on the host for ${opts.hostCwd} (expected at ${projectDir}). Run \`claude\` here at least once before using -c / --resume.`,
    );
  }

  const sessionPath = await pickSessionFile(projectDir, opts.mode);
  const sessionId = sessionPath.replace(/\.jsonl$/u, '').split('/').pop() ?? '';

  // Stage the rewritten copy in a host tmp dir. The caller will upload from
  // here via `provider.uploadPath`.
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-teleport-claude-'));
  const stagedFile = join(stage, `${sessionId}.jsonl`);
  await rewriteSessionFile(sessionPath, stagedFile, opts.hostCwd);
  opts.log?.(`teleport: claude session ${sessionId} staged for upload`);

  return {
    agent: 'claude',
    sessionId,
    hostFile: stagedFile,
    boxPath: `${BOX_CLAUDE_PROJECTS_DIR}/${sessionId}.jsonl`,
    boxParentDir: BOX_CLAUDE_PROJECTS_DIR,
    forwardArgs: ['--resume', sessionId],
  };
}

async function pickSessionFile(projectDir: string, mode: ResumeMode): Promise<string> {
  if (mode.kind === 'resume') {
    const target = join(projectDir, `${mode.id}.jsonl`);
    if (!existsSync(target)) {
      throw new TeleportError(
        `Claude session "${mode.id}" not found in ${projectDir}. List available sessions with: ls "${projectDir}"`,
      );
    }
    return target;
  }
  const entries = await readdir(projectDir);
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonl.length === 0) {
    throw new TeleportError(
      `no Claude sessions found in ${projectDir} — nothing to continue. Run \`claude\` here once first.`,
    );
  }
  const stats = await Promise.all(
    jsonl.map(async (name) => {
      const full = join(projectDir, name);
      const s = await stat(full);
      return { full, mtimeMs: s.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0]!.full;
}

async function rewriteSessionFile(
  src: string,
  dst: string,
  hostCwd: string,
): Promise<void> {
  const raw = await readFile(src, 'utf8');
  // Preserve original line endings — split on \n keeps a trailing empty entry
  // when the file ends with \n; we restore that on join.
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
      const obj = parsed as Record<string, unknown>;
      if (obj.cwd === hostCwd) {
        obj.cwd = BOX_WORKSPACE;
        out.push(JSON.stringify(obj));
        continue;
      }
    }
    out.push(line);
  }
  await mkdir(join(dst, '..'), { recursive: true });
  await writeFile(dst, out.join('\n'), 'utf8');
}
