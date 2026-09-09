/**
 * Seeded model-provider credentials: a host-held login a box may consume as its
 * model auth (`AgentSyncSpec.modelAuth`).
 *
 * The host's whole job is to decide WHICH login may enter the box and to land
 * it at that login's own canonical path, 0600, before the first supervisor
 * task runs. It rides the carry step for that reason: carry is the one step
 * every provider already runs at exactly that moment, with the same ownership
 * and mode rules a `perBoxCarry` channel token gets. What happens to the file
 * afterwards is the consuming agent's `ingest`, declared on its own row.
 *
 * One-way by construction. The entry is a host->box copy; `box.agents` still
 * gates the credential watch, extraction and the resume reconcile, so a copy
 * the daemon has since refreshed in its own store never flows back.
 */

import { stat } from 'node:fs/promises';
import {
  modelAuthEnvKey,
  modelAuthSourceId,
  type AgentModelAuthIngest,
  type AgentSyncSpec,
  type ResolvedCarryEntry,
} from '@agentbox/core';
import { findAgentSpec, resolveAgentSpec } from './sync/registry.js';
import { resolveHostCredentialFile } from './sync/concerns/credentials.js';

/**
 * Validate a create's requested model-auth sources against the agent's row.
 *
 * Refuses, rather than ignoring, an id the agent does not declare or one that
 * names an agent with no host-side `credential`: a silently dropped entry would
 * produce a box with no model auth and no message, which is the failure this
 * feature exists to end.
 *
 * A declared `env` source whose var is unset on this host is NOT an error — it
 * is reported and skipped where it is applied, the same way a missing login file
 * is (see {@link borrowedCredentialCarry}).
 */
export function resolveModelAuthSources(
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>,
  requested: readonly string[] | undefined,
): string[] {
  const wanted = [...new Set((requested ?? []).map((s) => s.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const sources = spec.modelAuth?.sources ?? [];
  const declared = new Map(sources.map((s) => [modelAuthSourceId(s), s]));
  for (const id of wanted) {
    const source = declared.get(id);
    if (!source) {
      const options = declared.size > 0 ? [...declared.keys()].join(', ') : 'nothing';
      throw new Error(`${spec.id} cannot use "${id}" as model auth — it declares ${options}`);
    }
    if (source.kind === 'agent' && !findAgentSpec(source.agent)?.credential) {
      throw new Error(
        `${spec.id} declares a borrow of "${source.agent}", which has no host-side credential`,
      );
    }
  }
  return wanted;
}

/** The agent-kind ids in a source list — the key the credential fan-out matches on. */
export function agentSourceIds(ids: readonly string[]): string[] {
  return ids.filter((id) => modelAuthEnvKey(id) === undefined);
}

/** The env var names in a source list. */
export function envSourceKeys(ids: readonly string[]): string[] {
  return ids.map((id) => modelAuthEnvKey(id)).filter((k): k is string => k !== undefined);
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
  /** A full source-id list; env sources are ignored, they carry no file. */
  agents: readonly string[],
  onLog?: (line: string) => void,
  /** Injectable for tests: where the host's login for an agent lives. */
  resolveFile: (
    agent: string,
  ) => Promise<{ path: string; text: string } | null> = resolveHostCredentialFile,
): Promise<ResolvedCarryEntry[]> {
  const out: ResolvedCarryEntry[] = [];
  for (const agent of agentSourceIds(agents)) {
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

/** How this agent ingests a seeded login, when it needs to. */
export function resolveModelAuthIngest(
  spec: Pick<AgentSyncSpec, 'modelAuth'>,
): AgentModelAuthIngest | undefined {
  return spec.modelAuth?.ingest;
}
