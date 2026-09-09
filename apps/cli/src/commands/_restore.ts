/**
 * `--restore <bot>` — the CLI half of putting a backed-up bot back into a box.
 *
 * The inverse of `_backup.ts`, and deliberately the same shape: the decisions a
 * hub route also needs (which bundle, is the source still alive, what goes
 * where) live in `@agentbox/sandbox-core`'s bot-backup concern, and what stays
 * here is what only a CLI knows — which flags were passed, and what to print.
 * The refusals are re-exported so the two front-ends cannot word them
 * differently.
 *
 * A restore is two halves that arrive by different routes. The workspace half is
 * just a directory, so it becomes the new box's project and rides the ordinary
 * create with no create-path change at all. The state half cannot: it belongs
 * inside the agent's own config dir, so it is pushed after the box exists, with
 * the agent stopped.
 */

import { log } from '@agentbox/cli-kit';
import { findProjectRoot } from '@agentbox/config';
import { isAbsolute, resolve } from 'node:path';
import type { AgentId, BoxRecord } from '@agentbox/core';
import {
  findAgentSpec,
  readState,
  resolveBotBundle,
  restoreAgentState,
  restoreWorkspaceDir,
  sourceBoxRunningRefusal,
  stageRestoreWorkspace as stageRestoreWorkspaceCore,
  type BotBundle,
} from '@agentbox/sandbox-core';
import { providerForBox } from '../provider/registry.js';
import { pullTransportForBox } from './_agent-pull-transport.js';

export { boxRefWithRestoreRefusal, existingBoxRefusal, restoreScope } from '@agentbox/sandbox-core';

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
 * workspace to a later backup. It runs on a live sibling under the same
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
    : restoreWorkspaceDir(projectRoot, bundle.bot);

  const declared = bundle.manifest.agent;
  const agent = bundle.stateDir && declared ? findAgentSpec(declared)?.id : undefined;
  return { bundle, workspaceDir, ...(agent ? { agent } : {}) };
}

/**
 * Refuse while the box this bundle came from is still running.
 *
 * The rule is shared (`sourceBoxRunningRefusal`); what is CLI-specific is where
 * the live state comes from — the local state file plus this host's provider.
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
  const refusal = sourceBoxRunningRefusal(source, live, bundle.bot);
  if (!refusal) return;
  if (force) {
    log.warn(`${source.name} is still running and holds this identity; --force given, continuing`);
    return;
  }
  throw new RestoreSourceRunningError(refusal);
}

/** Distinguished so the caller can exit 2 rather than 1, as `destroy` does. */
export class RestoreSourceRunningError extends Error {}

/**
 * Copy the bundle's workspace half to the live directory the box will run on.
 *
 * Wraps the shared stager only to re-word its refusal in this command's own
 * flags — `--into` and `--force` are CLI spellings the hub route does not share.
 */
export async function stageRestoreWorkspace(
  req: RestoreRequest,
  force: boolean | undefined,
): Promise<{ files: number }> {
  try {
    return await stageRestoreWorkspaceCore({
      bundle: req.bundle,
      workspaceDir: req.workspaceDir,
      ...(force ? { force: true } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('is not empty')) {
      throw new Error(
        `${req.workspaceDir} is not empty — pass --into <dir> for a different location, or --force to overwrite it`,
      );
    }
    throw err;
  }
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
