/**
 * Claude Code plan teleport. Copies a host plan-mode file
 * (`~/.claude/plans/<slug>.md`) into the box's `/home/vscode/.claude/plans/`
 * so a forked session can resume the plan there.
 *
 * Unlike the session JSONL resolver, a plan is plain markdown: there's no
 * top-level `cwd` field to swap. The only rewrite we do is a literal
 * host-workspace-path → `/workspace` replacement so plan text that references
 * host paths points at the box workspace.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BOX_WORKSPACE } from './cwd-encoding.js';
import { TeleportError, type ResolvedTeleport, type TeleportLogger } from './types.js';

/** In-box `~/.claude/plans/` directory (vscode user home). */
export const BOX_CLAUDE_PLANS_DIR = '/home/vscode/.claude/plans';

interface PlanResolveOptions {
  /** Host path to the plan file; `~`-prefixed or absolute/relative. */
  planPath: string;
  /** Host workspace absolute path — rewritten to `/workspace` in the plan text. */
  hostCwd: string;
  /** Override for tests. */
  hostHome?: string;
  log?: TeleportLogger;
}

/** Expand a leading `~` / `~/` to the host home, then resolve to absolute. */
function expandHome(p: string, hostHome: string): string {
  if (p === '~') return hostHome;
  if (p.startsWith('~/')) return join(hostHome, p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

export async function resolvePlanTeleport(opts: PlanResolveOptions): Promise<ResolvedTeleport> {
  const hostHome = opts.hostHome ?? homedir();
  const planFile = expandHome(opts.planPath, hostHome);

  if (!existsSync(planFile)) {
    throw new TeleportError(
      `plan file not found on the host: ${planFile}. Pass --plan with the path to a Claude Code plan (e.g. ~/.claude/plans/<slug>.md).`,
    );
  }

  const name = basename(planFile);
  // Stage a rewritten copy in a host tmp dir; the caller uploads from here via
  // `provider.uploadPath`.
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-teleport-plan-'));
  const stagedFile = join(stage, name);
  const raw = await readFile(planFile, 'utf8');
  // Literal rewrite: the box workspace is bind-mounted at /workspace, so any
  // reference to the host workspace path should follow it into the box. Resolve
  // to absolute first — a relative --workspace would otherwise match a substring
  // in the middle of an absolute path and double it (`/repo//workspace`).
  const absCwd = opts.hostCwd ? resolve(expandHome(opts.hostCwd, hostHome)) : '';
  const rewritten = absCwd ? raw.split(absCwd).join(BOX_WORKSPACE) : raw;
  await writeFile(stagedFile, rewritten, 'utf8');
  opts.log?.(`teleport: claude plan ${name} staged for upload`);

  return {
    agent: 'claude',
    sessionId: name,
    hostFile: stagedFile,
    boxPath: `${BOX_CLAUDE_PLANS_DIR}/${name}`,
    boxParentDir: BOX_CLAUDE_PLANS_DIR,
    forwardArgs: [],
  };
}
