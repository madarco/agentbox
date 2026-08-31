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
import { BOX_WORKSPACE } from '@agentbox/cli-kit';
import { TeleportError, type ResolvedTeleport, type TeleportLogger } from '@agentbox/cli-kit';

// The in-box destination is the AGENT's, so it arrives as `boxParentDir` rather
// than as a constant here. What stays is the generic staging: read a host file,
// rewrite it into a tmp dir, hand back a `ResolvedTeleport` the caller uploads.
//
// Importing claude's constant instead would have been the obvious move and is a
// trap: this module is bundled into the hub, and reaching into
// `@agentbox/agent-claude/cli` for one string drags that entry's whole
// dependency tree (node-pty included) into the hub build.

interface PlanResolveOptions {
  /** Host path to the plan file; `~`-prefixed or absolute/relative. */
  planPath: string;
  /** Host workspace absolute path — rewritten to `/workspace` in the plan text. */
  hostCwd: string;
  /** Override for tests. */
  hostHome?: string;
  log?: TeleportLogger;
  /**
   * In-box directory the plan is uploaded into — the agent's own
   * (`/home/vscode/.claude/plans` for claude). Supplied by the caller so this
   * module stays agent-neutral and stays cheap to bundle.
   */
  boxParentDir: string;
}

/** Expand a leading `~` / `~/` to the host home, then resolve to absolute. */
function expandHome(p: string, hostHome: string): string {
  if (p === '~') return hostHome;
  if (p.startsWith('~/')) return join(hostHome, p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

export async function resolvePlanTeleport(opts: PlanResolveOptions): Promise<ResolvedTeleport> {
  const { boxParentDir } = opts;
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
    boxPath: `${boxParentDir}/${name}`,
    boxParentDir,
    forwardArgs: [],
  };
}
