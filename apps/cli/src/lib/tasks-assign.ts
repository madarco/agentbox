/**
 * `--tasks T-11,T-12` on a create: point existing workspace tasks at the box the
 * create is about to build.
 *
 * Ids are checked BEFORE anything is provisioned — a typo should cost nothing,
 * not leave a box nobody wanted. After the create, assignment is best-effort: the
 * box exists either way, and failing the create over a bookkeeping call would be
 * worse than a warning.
 */
import { hostname } from 'node:os';
import { log } from '@agentbox/cli-kit';
import { findWorkspaceContaining } from '@agentbox/relay';
import type { HubApiClient, HubApiAssignTarget } from '../control-plane/hub-api-client.js';

/** Task ids are minted by the hub as `T-<n>`; the CLI only ever echoes them back. */
const TASK_ID_RE = /^T-\d+$/;

export class TaskIdError extends Error {}

/** Parse and validate a `--tasks` value into a deduped id list. */
export function parseTaskIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) throw new TaskIdError('--tasks needs at least one task id (e.g. T-11)');
  const bad = ids.filter((id) => !TASK_ID_RE.test(id));
  if (bad.length > 0) {
    throw new TaskIdError(`not a task id: ${bad.join(', ')} (expected T-<number>)`);
  }
  return [...new Set(ids)];
}

/**
 * Resolve the workspace that owns these tasks and confirm every id exists.
 * Returns the workspace id to assign against.
 */
export async function preflightTaskAssignment(
  client: HubApiClient,
  projectRoot: string,
  ids: string[],
): Promise<string> {
  const workspaces = await client.listWorkspaces();
  const ws =
    (process.env['AGENTBOX_WORKSPACE']
      ? workspaces.find((w) => w.id === process.env['AGENTBOX_WORKSPACE'])
      : undefined) ?? findWorkspaceContaining(workspaces, projectRoot, hostname());
  if (!ws) {
    throw new TaskIdError(
      `--tasks needs a workspace: no registered workspace contains ${projectRoot}. Register one with \`agentbox workspace add\`.`,
    );
  }
  const known = new Set((await client.listTasks(ws.id)).map((t) => t.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new TaskIdError(`unknown task ${missing.join(', ')} in workspace ${ws.name}`);
  }
  return ws.id;
}

/**
 * Assign after the create. `target` is the box id when the caller already has
 * one, else the create job id — the hub promotes that to the box id on its own
 * once the worker records it.
 */
export async function assignTasksBestEffort(
  client: HubApiClient,
  wsId: string,
  ids: string[],
  target: HubApiAssignTarget,
): Promise<void> {
  try {
    await client.assignTasks(wsId, ids, target);
    log.info(`tasks assigned: ${ids.join(', ')}`);
  } catch (err) {
    log.warn(
      `could not assign ${ids.join(', ')}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The whole `--tasks` flow for a create, as one call inside the hub-client
 * callback: validate before provisioning, then assign after. `create` hands back
 * the job id (the box does not exist yet); an inline create hands back the box id.
 */
export async function preflightOrExit(
  client: HubApiClient,
  projectRoot: string,
  ids: string[],
): Promise<string> {
  try {
    return await preflightTaskAssignment(client, projectRoot, ids);
  } catch (err) {
    if (err instanceof TaskIdError) {
      log.error(err.message);
      process.exit(4);
    }
    throw err;
  }
}

/** Parse a `--tasks` value, exiting with an actionable message on a bad id. */
export function parseTaskIdsOrExit(raw: string): string[] {
  try {
    return parseTaskIds(raw);
  } catch (err) {
    if (err instanceof TaskIdError) {
      log.error(err.message);
      process.exit(4);
    }
    throw err;
  }
}
