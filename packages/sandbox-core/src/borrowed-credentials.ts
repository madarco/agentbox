/**
 * Borrowed credentials: another agent's host-held login, seeded into a box for
 * a SERVICE agent to consume as model-provider auth
 * (`AgentSyncSpec.modelAuth`).
 *
 * The host's whole job is to decide WHICH login may enter the box and to land
 * it at that login's own canonical path, 0600, before the first supervisor
 * task runs. It rides the carry step for that reason: carry is the one step
 * every provider already runs at exactly that moment, with the same ownership
 * and mode rules a `perBoxCarry` channel token gets. What happens to the file
 * afterwards is the consuming agent's `ingestTask`, declared on its own row.
 *
 * One-way by construction. The entry is a host->box copy; `box.agents` still
 * gates the credential watch, extraction and the resume reconcile, so a copy
 * the daemon has since refreshed in its own store never flows back.
 */

import { stat } from 'node:fs/promises';
import type { AgentSyncSpec, ResolvedCarryEntry } from '@agentbox/core';
import { findAgentSpec, resolveAgentSpec } from './sync/registry.js';
import { resolveHostCredentialFile } from './sync/concerns/credentials.js';

/**
 * Validate a create's `borrowCredentials` against the agent's declaration.
 *
 * Refuses, rather than ignoring, an id the agent does not declare or one that
 * names an agent with no host-side `credential`: a silently dropped entry
 * would produce a box with no model auth and no message, which is the failure
 * this feature exists to end.
 */
export function resolveBorrowedCredentials(
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>,
  requested: readonly string[] | undefined,
): string[] {
  const wanted = [...new Set((requested ?? []).map((s) => s.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const declared = new Set((spec.modelAuth?.borrows ?? []).map((b) => b.agent));
  for (const id of wanted) {
    if (!declared.has(id)) {
      const options = declared.size > 0 ? [...declared].join(', ') : 'nothing';
      throw new Error(`${spec.id} cannot borrow "${id}" as model auth — it declares ${options}`);
    }
    if (!findAgentSpec(id)?.credential) {
      throw new Error(`${spec.id} declares a borrow of "${id}", which has no host-side credential`);
    }
  }
  return wanted;
}

/**
 * The carry entries that seed each borrowed login into the box.
 *
 * A login the host does not hold is reported and skipped, never fatal: the
 * box still comes up, its ingest task finds nothing and says so, and the user
 * can log in on the host and create again. Failing the create would leave no
 * box behind for a condition the message already explains.
 */
export async function borrowedCredentialCarry(
  agents: readonly string[],
  onLog?: (line: string) => void,
  /** Injectable for tests: where the host's login for an agent lives. */
  resolveFile: (
    agent: string,
  ) => Promise<{ path: string; text: string } | null> = resolveHostCredentialFile,
): Promise<ResolvedCarryEntry[]> {
  const out: ResolvedCarryEntry[] = [];
  for (const agent of agents) {
    const spec = resolveAgentSpec(agent);
    const credential = spec.credential;
    if (!credential) continue;
    const source = await resolveFile(spec.id);
    if (!source) {
      onLog?.(`model auth: no ${spec.id} login on this host — the box starts without it`);
      continue;
    }
    const st = await stat(source.path);
    onLog?.(`model auth: ${source.path} -> ${credential.boxAbsPath} (borrowed ${spec.id} login)`);
    out.push({
      rawSrc: source.path,
      rawDest: credential.boxAbsPath,
      absSrc: source.path,
      absDest: credential.boxAbsPath,
      kind: 'file',
      bytes: st.size,
      mode: 0o600,
      optional: true,
    });
  }
  return out;
}

/** The `service.tasks` entry that ingests borrowed logins, when the agent has one. */
export function borrowIngestTask(spec: Pick<AgentSyncSpec, 'modelAuth'>): string | undefined {
  return spec.modelAuth?.ingestTask;
}
