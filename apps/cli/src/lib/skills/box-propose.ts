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
import { join, posix, resolve, sep } from 'node:path';
import { tryGetMachineId } from '@agentbox/config';
import type { AgentId, BoxRecord, SyncTransport } from '@agentbox/core';
import {
  agentBoxDir,
  authoredTreeHash,
  discoverLocalSkills,
  readLocalSkill,
  resolveAgentSpec,
  SKILL_PROPOSAL_LIMITS,
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

/** The Agent Skills name rule (the library's): also a safe single path segment. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where one box skill is staged; throws unless it stays inside `stage`. */
export function stagedSkillDir(stage: string, n: number, name: string): string {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`not a valid skill name: ${name.slice(0, 80)}`);
  const root = resolve(stage);
  const dest = resolve(root, String(n), name);
  if (!dest.startsWith(`${root}${sep}`)) throw new Error(`skill path escapes staging: ${name}`);
  return dest;
}

/** Names of real skill dirs (not links: those are carried copies) with a SKILL.md. */
const LIST_SCRIPT = (dir: string): string =>
  `for d in '${dir}'/*/; do d="\${d%/}"; [ -L "$d" ] && continue; [ -f "$d/SKILL.md" ] && basename "$d"; done; true`;

/**
 * Checked IN the box before a skill is pulled out of it, as a courtesy that
 * keeps an honest too-big skill in the box: the first entry that is neither a
 * plain file, a directory nor a link (a FIFO, device or socket), and the bytes
 * of its files, skipping what a skill never carries (`.git`, `.DS_Store`). Prints
 * `<bad path or empty>\t<bytes>`, or nothing when `find` can't run (GNU `-printf`
 * / `-quit` missing), which refuses. The box answers this, so the real limits
 * are host-side: `pullTree`'s `maxBytes` and `readLocalSkill`.
 */
export const PROBE_SCRIPT = (dir: string): string =>
  `d='${dir}'; ` +
  `bad=$(find "$d" -mindepth 1 \\( -name .git -o -name .DS_Store \\) -prune -o ! -type f ! -type d ! -type l -print -quit) || exit 3; ` +
  `sizes=$(find "$d" \\( -name .git -o -name .DS_Store \\) -prune -o -type f -printf '%s\\n') || exit 3; ` +
  `bytes=$(printf '%s\\n' "$sizes" | awk '{s+=$1} END {printf "%d", s}'); ` +
  `printf '%s\\t%s\\n' "$bad" "$bytes"`;

/**
 * Why a probed box skill must not be pulled, or null. Links are allowed (the
 * host resolves them and drops any that leave the skill); FIFOs, devices and
 * sockets are not, nor a skill over `maxBytes`.
 */
export function probeRefusal(stdout: string, dir: string, maxBytes: number): string | null {
  // Not trim(): a clean probe's line STARTS with the tab of an empty path.
  const line = stdout.replace(/\n+$/, '').split('\n').at(-1) ?? '';
  if (!line.includes('\t')) return 'it could not be checked in the box';
  const [bad = '', rawBytes = ''] = line.split('\t');
  if (bad) {
    const rel = bad.startsWith(`${dir}/`) ? bad.slice(dir.length + 1) : bad;
    return `holds ${rel.slice(0, 120)}, which is not a plain file, folder or link (FIFOs and devices are not proposed)`;
  }
  const bytes = Number(rawBytes);
  if (!Number.isFinite(bytes) || rawBytes === '') return 'it could not be checked in the box';
  if (bytes > maxBytes) {
    return `${String(bytes)} bytes, over the ${String(maxBytes)}-byte cap for a proposed skill`;
  }
  return null;
}

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
  // The hub refuses a bigger one anyway; refusing it here keeps it in the box.
  const maxBytes = Math.min(opts.maxBytes, SKILL_PROPOSAL_LIMITS.maxBytes);
  const [listing, local] = await Promise.all([
    opts.client.listSkills(),
    discoverLocalSkills({ home: opts.home, maxBytes: opts.maxBytes }).catch(() => []),
  ]);
  const library = new Map(listing.skills.map((s) => [s.name, s.current]));
  // Authored files only: a carried skill the agent merely ran leaves
  // `__pycache__` / `node_modules` behind, which must not read as an edit.
  const onThisPc = new Set(local.map((s) => authoredTreeHash(s.files)));
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
        // The names come from the box's stdout, which an agent in the box
        // controls: check them before any host path is built from one.
        if (!SKILL_NAME_RE.test(name)) {
          out.push({
            name: name.slice(0, 80),
            status: 'skipped',
            reason: 'not a valid skill name',
          });
          continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === 'agentbox' || name.startsWith('agentbox-')) continue;
        const boxDir = posix.join(dir, name);
        // Before anything leaves the box: no links or special files, and a size
        // the hub would accept, so a planted skill can fill neither this disk
        // nor a read that never ends.
        const probe = await opts.transport.exec(['sh', '-c', PROBE_SCRIPT(boxDir)]);
        const refusal =
          probe.exitCode === 0
            ? probeRefusal(probe.stdout, boxDir, maxBytes)
            : 'it could not be checked in the box';
        if (refusal) {
          out.push({ name, status: 'skipped', reason: refusal });
          continue;
        }
        const dest = stagedSkillDir(stage, seen.size, name);
        await mkdir(dest, { recursive: true });
        let skill: LocalSkill;
        try {
          // The cap the probe can't guarantee (the box answered it), enforced
          // here on what actually crosses to this machine. Tar framing on top.
          await opts.transport.pullTree(boxDir, dest, {
            exclude: ['.git'],
            maxBytes: maxBytes + 1024 * 1024,
          });
          skill = await readLocalSkill(name, dest, { maxBytes });
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
        if (onThisPc.has(authoredTreeHash(skill.files)) || library.get(name) === skill.treeSha) {
          continue;
        }
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
