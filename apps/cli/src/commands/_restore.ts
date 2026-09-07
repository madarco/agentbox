/**
 * `--restore <bot>` — the CLI half of putting a backed-up bot back into a box.
 *
 * The inverse of `_backup.ts`, and deliberately the same shape: the decisions
 * that a hub route would also need (which bundle, is the source still alive,
 * what goes where) live in `@agentbox/sandbox-core`'s bot-backup concern, and
 * what stays here is what only a CLI knows — which flags were passed, and what
 * to print.
 *
 * A restore is two halves that arrive by different routes. The workspace half is
 * just a directory, so it becomes the new box's project and rides the ordinary
 * create with no create-path change at all. The state half cannot: it belongs
 * inside the agent's own config dir, so it is pushed after the box exists, with
 * the agent stopped.
 */

import { log } from '@agentbox/cli-kit';
import { findProjectRoot } from '@agentbox/config';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentId, BoxRecord } from '@agentbox/core';
import {
  botDir,
  findAgentSpec,
  readState,
  resolveBotBundle,
  restoreAgentState,
  type BotBundle,
} from '@agentbox/sandbox-core';
import { providerForBox } from '../provider/registry.js';
import { pullTransportForBox } from './_agent-pull-transport.js';

export interface RestoreRequest {
  bundle: BotBundle;
  /** The live workspace the restored box runs on — NOT the immutable bundle. */
  workspaceDir: string;
  /** The agent whose state the bundle carries, when it carries one. */
  agent?: AgentId;
}

export interface RestoreOptions {
  restore?: string;
  stamp?: string;
  into?: string;
  force?: boolean;
}

/**
 * Resolve `--restore` against the project the command was run in.
 *
 * The restored box does NOT run on the bundle's own `workspace/`: that copy is
 * immutable and `--keep` may prune it, so a box writing into it would lose its
 * workspace to a later backup. It runs on a live sibling,
 * `<project>/.agentbox/bots/<bot>/workspace`, which stays inside the same
 * gitignored, never-seeded directory as the backups it came from.
 */
export async function resolveRestoreRequest(
  workspace: string,
  opts: RestoreOptions,
): Promise<RestoreRequest> {
  const bot = (opts.restore ?? '').trim();
  if (bot.length === 0 || bot.includes('/') || bot === '.' || bot === '..') {
    throw new Error(`--restore ${opts.restore ?? ''}: a bot name must be a single path segment`);
  }
  const projectRoot = (await findProjectRoot(workspace)).root;
  const bundle = await resolveBotBundle(projectRoot, bot, opts.stamp?.trim() || undefined);

  // `~` is not expanded here for the same reason `clone --into` refuses it: a
  // quoted tilde reaching us means "home", and creating a directory literally
  // named `~` is never what was meant.
  const raw = opts.into?.trim();
  if (raw === '~' || raw?.startsWith('~/')) {
    throw new Error(`--into ${raw}: '~' is not expanded here — write the path out`);
  }
  const workspaceDir = raw
    ? isAbsolute(raw)
      ? raw
      : resolve(process.cwd(), raw)
    : join(botDir(projectRoot, bundle.bot), 'workspace');

  const declared = bundle.manifest.agent;
  const agent = bundle.stateDir && declared ? findAgentSpec(declared)?.id : undefined;
  return { bundle, workspaceDir, ...(agent ? { agent } : {}) };
}

/**
 * Refuse while the box this bundle came from is still running.
 *
 * Two live gateways holding one identity is the multi-tenancy failure OpenClaw's
 * per-box config volume exists to prevent, and a restore is the one operation
 * that can produce it. The box being GONE is the normal case — that is what a
 * restore is for — so an unknown or absent record proceeds silently; only a
 * record we can still see running stops it.
 */
export async function assertSourceBoxNotRunning(
  bundle: BotBundle,
  force: boolean | undefined,
): Promise<void> {
  const state = await readState().catch(() => null);
  const source = state?.boxes.find((b) => b.id === bundle.manifest.boxId);
  if (!source) return;
  let live: string;
  try {
    live = await (await providerForBox(source)).probeState(source);
  } catch {
    return;
  }
  if (live !== 'running') return;
  if (force) {
    log.warn(`${source.name} is still running and holds this identity; --force given, continuing`);
    return;
  }
  throw new RestoreSourceRunningError(
    `box ${source.name} is still running and holds ${bundle.bot}'s identity — ` +
      `two live gateways cannot share one. Stop or destroy it, or pass --force.`,
  );
}

/** Distinguished so the caller can exit 2 rather than 1, as `destroy` does. */
export class RestoreSourceRunningError extends Error {}

/**
 * Copy the bundle's workspace half to the live directory the box will run on.
 *
 * Refuses a non-empty destination unless `--force`: the usual reason it is
 * non-empty is an earlier restore of the same bot that is still in use, and
 * overwriting it in place would take the running box's files out from under it.
 */
export async function stageRestoreWorkspace(
  req: RestoreRequest,
  force: boolean | undefined,
): Promise<{ files: number }> {
  await mkdir(req.workspaceDir, { recursive: true });
  const existing = await readdir(req.workspaceDir);
  if (existing.length > 0 && !force) {
    throw new Error(
      `${req.workspaceDir} is not empty — pass --into <dir> for a different location, or --force to overwrite it`,
    );
  }
  await cp(req.bundle.workspaceDir, req.workspaceDir, { recursive: true, force: true });
  return { files: (await readdir(req.workspaceDir)).length };
}

/**
 * Push the state half into a box whose agent has been stopped.
 *
 * The transport is the same one the backup read through: cloud transport, or for
 * docker the agent's config volume mounted at its box path.
 */
export async function restoreStateIntoBox(args: {
  box: BoxRecord;
  agent: AgentId;
  bundle: BotBundle;
}): Promise<{ clearedSidecars: string[] }> {
  const stateDir = args.bundle.stateDir;
  if (!stateDir) throw new Error(`${args.bundle.dir}: this backup captured no agent state`);
  const { transport } = await pullTransportForBox(args.box, args.agent);
  return await restoreAgentState({ agent: args.agent, transport, srcDir: stateDir });
}
