/**
 * "Propose to library" (docs/hub-skills-plan.md, Phase 7): after
 * `agentbox download <agent>`, offer every skill an agent wrote inside the box
 * to the hub's library. Each one becomes a pending approval on the hub; nothing
 * lands until a human approves it there.
 *
 * Read through the same `SyncTransport` the download uses, so docker (the
 * agent's config volume, box stopped or not) and every cloud provider share
 * one path. Only the agent's skill dirs inside its box config dir are read: the
 * docker transport mounts that dir and nothing else.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { tryGetMachineId } from '@agentbox/config';
import type { AgentId, BoxRecord, SyncTransport } from '@agentbox/core';
import {
  agentBoxDir,
  discoverLocalSkills,
  readLocalSkill,
  resolveAgentSpec,
  writeTar,
  type LocalSkill,
} from '@agentbox/sandbox-core';
import type { HubApiClient, HubApiSkillProposal } from '../../control-plane/hub-api-client.js';

/** The agent's skill dirs as box paths its config dir holds (opencode's relocated config included). */
export function boxSkillDirs(agent: AgentId): string[] {
  const spec = resolveAgentSpec(agent);
  const root = agentBoxDir(agent);
  const out: string[] = [];
  for (const rel of spec.skills?.dirs ?? []) {
    const parts = rel.split('/').filter(Boolean);
    for (const p of spec.staticPaths) {
      const host = p.hostHomeRel ?? [];
      if (host.length === 0 || host.length > parts.length) continue;
      if (!host.every((seg, i) => parts[i] === seg)) continue;
      const box = posix.join(p.boxDir, p.relocToSubpath ?? '', ...parts.slice(host.length));
      if ((box === root || box.startsWith(`${root}/`)) && !out.includes(box)) out.push(box);
      break;
    }
  }
  return out;
}

/** Names of real skill dirs (not links: those are carried copies) with a SKILL.md. */
const LIST_SCRIPT = (dir: string): string =>
  `for d in '${dir}'/*/; do d="\${d%/}"; [ -L "$d" ] && continue; [ -f "$d/SKILL.md" ] && basename "$d"; done; true`;

export type BoxSkillOutcome =
  | { name: string; status: 'pending' | 'unchanged'; isNew: boolean; findings: number }
  | { name: string; status: 'skipped'; reason: string }
  | { name: string; status: 'failed'; reason: string };

export interface ProposeBoxSkillsOptions {
  client: HubApiClient;
  box: BoxRecord;
  agent: AgentId;
  transport: SyncTransport;
  /** This PC's home, to skip skills it already has (carried copies). */
  home: string;
  maxBytes: number;
}

/**
 * Find the skills written in the box and propose each one the library lacks
 * (or has at another version) and this PC doesn't have as-is.
 */
export async function proposeBoxSkills(opts: ProposeBoxSkillsOptions): Promise<BoxSkillOutcome[]> {
  const dirs = boxSkillDirs(opts.agent);
  if (dirs.length === 0) return [];
  const [listing, local] = await Promise.all([
    opts.client.listSkills(),
    discoverLocalSkills({ home: opts.home, maxBytes: opts.maxBytes }).catch(() => []),
  ]);
  const library = new Map(listing.skills.map((s) => [s.name, s.current]));
  const onThisPc = new Set(local.map((s) => s.treeSha));
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-box-skills-'));
  const out: BoxSkillOutcome[] = [];
  const seen = new Set<string>();
  try {
    for (const dir of dirs) {
      const r = await opts.transport.exec(['sh', '-c', LIST_SCRIPT(dir)]);
      const names = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === 'agentbox' || name.startsWith('agentbox-')) continue;
        const dest = join(stage, String(seen.size), name);
        await mkdir(dest, { recursive: true });
        let skill: LocalSkill;
        try {
          await opts.transport.pullTree(posix.join(dir, name), dest);
          skill = await readLocalSkill(name, dest, { maxBytes: opts.maxBytes });
        } catch (err) {
          out.push({
            name,
            status: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (skill.problems.length > 0) {
          out.push({ name, status: 'skipped', reason: skill.problems.join('; ') });
          continue;
        }
        // Carried from a PC (this one, as-is) or already the library's version.
        if (onThisPc.has(skill.treeSha) || library.get(name) === skill.treeSha) continue;
        try {
          const res: HubApiSkillProposal = await opts.client.proposeSkill(
            name,
            writeTar(skill.files),
            {
              box: { id: opts.box.id, name: opts.box.name },
              agent: opts.agent,
              source: {
                host: `box ${opts.box.name}`,
                ...(tryGetMachineId() ? { machineId: tryGetMachineId()! } : {}),
                path: posix.join(dir, name),
              },
            },
          );
          out.push({
            name,
            status: res.status,
            isNew: res.isNew,
            findings: res.findings.length,
          });
        } catch (err) {
          out.push({
            name,
            status: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return out;
}

/** One line per proposal, for the download commands. */
export function describeBoxSkillOutcomes(outcomes: readonly BoxSkillOutcome[]): string[] {
  const lines: string[] = [];
  const pending = outcomes.filter((o) => o.status === 'pending');
  for (const o of outcomes) {
    if (o.status === 'pending') {
      lines.push(
        `  ${o.name}: proposed ${o.isNew ? 'as a new library skill' : 'as a new version'}` +
          `${o.findings > 0 ? ` (secret scan: ${String(o.findings)} finding(s))` : ''}`,
      );
    } else if (o.status === 'unchanged') {
      lines.push(`  ${o.name}: the library already has this version`);
    } else if ('reason' in o) {
      lines.push(`  ${o.name}: not proposed (${o.reason})`);
    }
  }
  if (pending.length > 0) {
    lines.push(
      `${String(pending.length)} skill proposal(s) wait for approval in the hub (web Approvals, the tray, or a box footer); approved skills reach new boxes.`,
    );
  }
  return lines;
}

/** Shown when the step can't reach a hub; the download itself already finished. */
export function proposeHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `skills were not proposed to the hub library: ${msg}`;
}
