/**
 * Run an agent's model-auth ingest inside a box.
 *
 * The host has already landed the borrowed login at the LENDER's own canonical
 * path; this turns it into the consuming agent's own auth state. AgentBox never
 * learns that format — the row owns the script — so all this does is pick the
 * right way to run it:
 *
 *  - `serviceTask` goes through ctl, which owns the agent's DAG.
 *  - `command` is run directly, because a TUI agent has no supervisor unit to
 *    hang a task on: ctl's wire cannot express a task without a service, and
 *    that narrowing lives in a BAKED binary, so a new branch there would be
 *    silently skipped by every box built from an existing image or snapshot.
 *
 * Best-effort by contract. A box whose ingest fails must still come up — the
 * agent then has no model auth and says so, which is a better outcome than a
 * box that does not exist. The row's script is itself gated on a hash of the
 * seed, so running this on every launch is a no-op after the first.
 */

import type { AgentSyncSpec } from '@agentbox/core';
import { resolveModelAuthIngest } from './borrowed-credentials.js';

export interface IngestExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ModelAuthIngestResult {
  /** False when the row declares no ingest — an `env`-only agent, say. */
  ran: boolean;
  exitCode?: number;
  /** The task or command name, for logging. */
  name?: string;
}

export interface ModelAuthIngestOptions {
  /** Re-import even if the row's own gate would skip. Used by the fan-out. */
  force?: boolean;
  onLog?: (line: string) => void;
}

/** The argv that runs this agent's ingest in the box. */
export function modelAuthIngestArgv(
  spec: Pick<AgentSyncSpec, 'modelAuth'>,
  force = false,
): string[] | undefined {
  const ingest = resolveModelAuthIngest(spec);
  if (!ingest) return undefined;
  return ingest.kind === 'serviceTask'
    ? ['agentbox-ctl', 'run-task', ingest.task, ...(force ? ['--force'] : [])]
    : ['bash', '-lc', ingest.command];
}

export async function runModelAuthIngest(
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>,
  exec: (argv: string[]) => Promise<IngestExecResult>,
  opts: ModelAuthIngestOptions = {},
): Promise<ModelAuthIngestResult> {
  const ingest = resolveModelAuthIngest(spec);
  const argv = modelAuthIngestArgv(spec, opts.force);
  if (!ingest || !argv) return { ran: false };
  const name = ingest.kind === 'serviceTask' ? ingest.task : ingest.name;
  try {
    const res = await exec(argv);
    const out = `${res.stdout}${res.stderr}`.trim();
    if (out.length > 0) for (const line of out.split('\n')) opts.onLog?.(`${name}: ${line}`);
    return { ran: true, exitCode: res.exitCode, name };
  } catch (err) {
    // Never fatal: see the contract above.
    opts.onLog?.(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: true, name };
  }
}
