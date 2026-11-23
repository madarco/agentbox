// The web UI's SKILL.md editor (docs/hub-skills-plan.md, Phase 6). A browser
// can't build a skill tarball and its tree hash, so the hub does: it reads the
// base version back from custody, swaps SKILL.md, checks the frontmatter and the
// secret scan, and stores the result as a new `upload` version through
// `importSkill`, exactly as a PC upload would land.
import { Readable } from 'node:stream';
import {
  parseSkillFrontmatter,
  readTar,
  scanSkillFiles,
  SkillTarError,
  treeHash,
  writeTar,
  type SecretFinding,
  type TarFile,
} from '@agentbox/sandbox-core';
import {
  importSkill,
  openSkillTarball,
  readSkillMeta,
  skillNameProblem,
  SkillsError,
  type ImportResult,
  type SkillsStore,
} from './skills';

/** SKILL.md bodies above this are refused: it is instructions, not a payload. */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

export interface SkillMdRead {
  name: string;
  version: string;
  content: string;
  /** Every file of that version, so the editor can say what else the skill holds. */
  files: { path: string; size: number; mode: number }[];
}

export interface SkillMdSaveInput {
  content: string;
  /** The version the editor opened. A save over a skill whose current moved since is refused. */
  base?: string;
  allowFindings?: boolean;
}

export interface SkillMdSaveResult extends ImportResult {
  findings: SecretFinding[];
}

async function readVersionFiles(
  store: SkillsStore,
  name: string,
  version: string,
  maxBytes?: number,
): Promise<TarFile[]> {
  const t = await openSkillTarball(store, name, version);
  const chunks: Buffer[] = [];
  for await (const c of t.data as AsyncIterable<Buffer | string>) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  }
  try {
    return readTar(Buffer.concat(chunks), maxBytes !== undefined ? { maxBytes } : {});
  } catch (err) {
    if (err instanceof SkillTarError) throw new SkillsError('invalid_request', err.message);
    throw err;
  }
}

/** A version's SKILL.md (default: current). Throws `not_found`. */
export async function readSkillMd(
  store: SkillsStore,
  name: string,
  version?: string,
): Promise<SkillMdRead> {
  const meta = await readSkillMeta(store, name);
  if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  const v = version ?? meta.current;
  const files = await readVersionFiles(store, name, v);
  const md = files.find((f) => f.path === 'SKILL.md');
  return {
    name,
    version: v,
    content: md ? md.data.toString('utf8') : '',
    files: files.map((f) => ({ path: f.path, size: f.data.length, mode: f.mode })),
  };
}

/**
 * Save SKILL.md as a new version. A skill that doesn't exist yet is created with
 * SKILL.md as its only file. The result is an `upload`: the user wrote it here.
 */
export async function saveSkillMd(
  store: SkillsStore,
  name: string,
  input: SkillMdSaveInput,
  opts: { maxTarballBytes?: number; now?: Date } = {},
): Promise<SkillMdSaveResult> {
  const problem = skillNameProblem(name);
  if (problem) throw new SkillsError('invalid_request', problem);
  const data = Buffer.from(input.content, 'utf8');
  if (data.length > SKILL_MD_MAX_BYTES) {
    throw new SkillsError('invalid_request', 'SKILL.md is larger than 512 KB');
  }
  const fm = parseSkillFrontmatter(input.content);
  if (!fm) {
    throw new SkillsError('invalid_request', 'SKILL.md needs a frontmatter block (--- ... ---)');
  }
  if (fm.name !== name) {
    throw new SkillsError(
      'invalid_request',
      `SKILL.md names itself '${fm.name ?? ''}', not '${name}' (the frontmatter name must match)`,
    );
  }
  const description = fm.description ?? '';
  if (!description || description.length > 2048) {
    throw new SkillsError('invalid_request', 'SKILL.md needs a description (max 2048 chars)');
  }

  const meta = await readSkillMeta(store, name);
  // A cheap early answer; the authoritative check runs again under the skill's
  // lock in importSkill (expectCurrent), so two concurrent saves can't both land.
  if ((meta?.current ?? null) !== (input.base ?? null)) {
    throw new SkillsError(
      'conflict',
      !meta
        ? `skill '${name}' was discarded since the editor opened it`
        : input.base === undefined
          ? `skill '${name}' already exists; open it to edit`
          : `skill '${name}' changed since the editor opened it (now ${meta.current.slice(0, 12)}); reload and edit again`,
    );
  }

  const others = meta
    ? (await readVersionFiles(store, name, meta.current, opts.maxTarballBytes)).filter(
        (f) => f.path !== 'SKILL.md',
      )
    : [];
  const files: TarFile[] = [...others, { path: 'SKILL.md', mode: 0o644, data }];
  const findings = scanSkillFiles(files);
  if (findings.length > 0 && input.allowFindings !== true) {
    const f = findings[0]!;
    throw new SkillsError(
      'invalid_request',
      `secret scan: ${f.rule} in ${f.path}:${String(f.line)}${findings.length > 1 ? ` (+${String(findings.length - 1)} more)` : ''}; save with allowFindings to store it anyway`,
    );
  }
  const result = await importSkill(store, {
    name,
    meta: {
      sha256: treeHash(files),
      description,
      size: files.reduce((n, f) => n + f.data.length, 0),
      files: files.length,
      source: { host: 'web' },
    },
    body: Readable.from([writeTar(files)]),
    origin: { kind: 'upload' },
    expectCurrent: input.base ?? null,
    // The user's own edit: no approval round, whatever the skill's policy.
    apply: true,
    ...(opts.maxTarballBytes !== undefined ? { maxBytes: opts.maxTarballBytes } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { ...result, findings };
}
