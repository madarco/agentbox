// Skill proposals (docs/hub-skills-plan.md, Phase 7): a skill written by an
// agent inside a box reaches the library only after one human approval.
// `agentbox download <agent>` finds such skills and sends each here
// (`POST /api/v1/skills/{name}/propose`); the hub reads the tarball itself, so
// the approver sees the hub's own tree hash, frontmatter check, secret scan and
// SKILL.md preview, not what the uploader claims. The tarball waits in memory
// until the answer (an unanswered approval resolves to no after a day, and a
// hub restart drops it with the prompt mailbox).
import { Readable } from 'node:stream';
import type { McpApprovalRequest } from '@agentbox/core';
import {
  parseSkillFrontmatter,
  readTar,
  scanSkillFiles,
  SkillTarError,
  treeHash,
  type SecretFinding,
  type TarFile,
} from '@agentbox/sandbox-core';
import {
  importSkill,
  readSkillMeta,
  SKILLS_SCOPE,
  skillNameProblem,
  SkillsError,
  type SkillSource,
  type SkillsStore,
} from './skills';

export interface SkillProposalDeps {
  store: SkillsStore;
  /** Park an approval in the relay's prompt mailbox under `boxId`; resolves on the answer. */
  approve(boxId: string, req: McpApprovalRequest): Promise<boolean>;
  log?: (line: string) => void;
  /** Proposals waiting for an answer at once (their tarballs are held in memory). */
  maxPending?: number;
  /** Cap on a skill's unpacked bytes (custody's blob cap, by default unbounded here). */
  maxBytes?: number;
}

export interface SkillProposalInput {
  name: string;
  tarball: Buffer;
  /** The box the skill was written in. */
  box: { id: string; name: string };
  /** The agent whose skill dir it was read from. */
  agent?: string;
  /** Where it was read, recorded on the version once approved. */
  source?: SkillSource;
}

export interface SkillProposalResult {
  name: string;
  /** Tree hash the hub derived from the tarball. */
  version: string;
  /** `unchanged`: the library already holds this version; nothing was asked. */
  status: 'pending' | 'unchanged';
  /** True when the library has no skill of this name yet. */
  isNew: boolean;
  findings: SecretFinding[];
}

const DEFAULT_MAX_PENDING = 20;
const PREVIEW_CHARS = 1_500;

function fmtBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const LISTING_CHARS = 2_000;
/** Lines per side past which SKILL.md is shown whole instead of diffed. */
const DIFF_MAX_LINES = 400;

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [${String(text.length - max)} more chars]`
    : text;
}

/** A version's files by path, or null when its tarball is missing or unreadable. */
async function readVersionFiles(
  store: SkillsStore,
  name: string,
  version: string,
  maxBytes: number | undefined,
): Promise<Map<string, Buffer> | null> {
  const found = await store.get(`${SKILLS_SCOPE}/${name}/${version}.tar.gz`).catch(() => null);
  if (!found) return null;
  try {
    const files = readTar(found.data, maxBytes !== undefined ? { maxBytes } : {});
    return new Map(files.map((f) => [f.path, f.data]));
  } catch {
    return null;
  }
}

/** Paths added, modified (content or mode) and removed, each sorted. */
export function diffFiles(
  current: Map<string, Buffer>,
  next: readonly TarFile[],
): { added: string[]; modified: string[]; removed: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const seen = new Set<string>();
  for (const f of next) {
    seen.add(f.path);
    const old = current.get(f.path);
    if (!old) added.push(f.path);
    else if (!old.equals(f.data)) modified.push(f.path);
  }
  const removed = [...current.keys()].filter((p) => !seen.has(p));
  const sort = (a: string[]) => a.sort();
  return { added: sort(added), modified: sort(modified), removed: sort(removed) };
}

/** A minimal line diff (LCS): `- ` removed, `+ ` added, `  ` kept lines. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return `(too long to diff; new content follows)\n${after}`;
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]!}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i++]!}`);
    } else {
      out.push(`+ ${b[j++]!}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]!}`);
  while (j < b.length) out.push(`+ ${b[j++]!}`);
  return out.join('\n');
}

export interface SkillProposals {
  propose(input: SkillProposalInput): Promise<SkillProposalResult>;
  /** Proposals waiting for an answer. */
  pending(): number;
}

export function createSkillProposals(deps: SkillProposalDeps): SkillProposals {
  const maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING;
  /** `<name>@<version>` of every proposal waiting for an answer. */
  const waiting = new Set<string>();

  async function propose(input: SkillProposalInput): Promise<SkillProposalResult> {
    const { name, tarball } = input;
    const problem = skillNameProblem(name);
    if (problem) throw new SkillsError('invalid_request', problem);
    let files;
    try {
      files = readTar(tarball, deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {});
    } catch (err) {
      if (err instanceof SkillTarError) throw new SkillsError('invalid_request', err.message);
      throw err;
    }
    const skillMd = files.find((f) => f.path === 'SKILL.md');
    if (!skillMd) throw new SkillsError('invalid_request', `skill '${name}' has no SKILL.md`);
    const fm = parseSkillFrontmatter(skillMd.data.toString('utf8'));
    if (!fm) throw new SkillsError('invalid_request', `${name}/SKILL.md has no frontmatter`);
    if (fm.name !== name) {
      throw new SkillsError(
        'invalid_request',
        `${name}/SKILL.md names itself '${fm.name ?? ''}', not '${name}'`,
      );
    }
    const description = fm.description ?? '';
    if (!description || description.length > 2048) {
      throw new SkillsError(
        'invalid_request',
        `${name}/SKILL.md needs a description (max 2048 chars)`,
      );
    }
    const version = treeHash(files);
    const size = files.reduce((n, f) => n + f.data.length, 0);
    const findings = scanSkillFiles(files);
    const prev = await readSkillMeta(deps.store, name);
    const base = { name, version, isNew: !prev, findings };
    // A version the library holds (current or older) is not new: proposing an
    // older one would roll the library back (a stale carried copy).
    if (prev?.versions.some((v) => v.sha256 === version)) return { ...base, status: 'unchanged' };

    const key = `${name}@${version}`;
    // The same proposal again (a second download) waits on the first prompt.
    if (waiting.has(key)) return { ...base, status: 'pending' };
    if (waiting.size >= maxPending) {
      throw new SkillsError(
        'invalid_request',
        `${String(waiting.size)} skill proposals are already waiting for an answer; answer them first`,
      );
    }
    waiting.add(key);

    const scanLine =
      findings.length > 0
        ? `secret scan: ${String(findings.length)} finding(s): ${findings
            .slice(0, 3)
            .map((f) => `${f.rule} in ${f.path}:${String(f.line)}`)
            .join(', ')}`
        : 'secret scan: clean';
    const text = skillMd.data.toString('utf8');
    const baseCurrent = prev?.current ?? null;
    // What the approver needs: every file that differs from the current
    // version, not just SKILL.md (a changed script under an unchanged SKILL.md
    // must not look identical).
    const current = baseCurrent
      ? await readVersionFiles(deps.store, name, baseCurrent, deps.maxBytes)
      : null;
    const changes = current ? diffFiles(current, files) : null;
    const changeLine = !prev
      ? `new skill: ${String(files.length)} file(s)`
      : changes
        ? `vs current ${baseCurrent!.slice(0, 12)}: ${String(changes.added.length)} added, ${String(changes.modified.length)} modified, ${String(changes.removed.length)} removed`
        : `vs current ${baseCurrent!.slice(0, 12)}: its files could not be read; every file is listed`;
    const listing = changes
      ? [
          ...changes.added.map((p) => `+ ${p}`),
          ...changes.modified.map((p) => `~ ${p}`),
          ...changes.removed.map((p) => `- ${p}`),
        ]
      : files.map((f) => `  ${f.path} (${fmtBytes(f.data.length)})`);
    const oldMd = current?.get('SKILL.md');
    const mdSection = !prev
      ? `SKILL.md:\n${clip(text, PREVIEW_CHARS)}`
      : oldMd === undefined
        ? `SKILL.md (new file):\n${clip(text, PREVIEW_CHARS)}`
        : oldMd.equals(skillMd.data)
          ? 'SKILL.md: unchanged'
          : `SKILL.md diff:\n${clip(lineDiff(oldMd.toString('utf8'), text), PREVIEW_CHARS)}`;
    const summary = [
      scanLine,
      changeLine,
      clip(listing.join('\n'), LISTING_CHARS),
      '',
      mdSection,
    ].join('\n');
    // Only these reach the approval callback, so the unpacked files can be freed.
    const fileCount = files.length;
    const approved = deps.approve(input.box.id, {
      message: `Box ${input.box.name} proposes ${prev ? 'a new version of' : 'a new'} library skill ${name}`,
      detail: `${changeLine}, ${fmtBytes(size)}; ${scanLine} — ${description.slice(0, 200)}`,
      summary,
      command: 'skills_propose',
      noAutoApprove: true,
    });
    // Not awaited: the caller learns `pending` now; a human decides later.
    void approved
      .then(async (yes) => {
        if (!yes) {
          deps.log?.(`skills: proposal ${name} from ${input.box.name} declined`);
          return;
        }
        const now = await readSkillMeta(deps.store, name);
        if ((now?.current ?? null) !== baseCurrent) {
          deps.log?.(
            `skills: proposal ${name} from ${input.box.name} approved but not applied: the library's version changed after it was made`,
          );
          return;
        }
        const r = await importSkill(deps.store, {
          name,
          meta: {
            sha256: version,
            description,
            size,
            files: fileCount,
            source: input.source ?? { host: `box ${input.box.name}` },
          },
          body: Readable.from([tarball]),
        });
        deps.log?.(
          `skills: proposal ${name} from ${input.box.name} approved (${r.version.slice(0, 12)})`,
        );
      })
      .catch((err: unknown) => {
        deps.log?.(
          `skills: proposal ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => waiting.delete(key));
    return { ...base, status: 'pending' };
  }

  return { propose, pending: () => waiting.size };
}
