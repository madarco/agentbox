/**
 * `pcskills.*` — the PC side of the hub's skills page (docs/hub-settings-plan.md,
 * Phase 2). The hub asks a PC for its skills inventory, for one skill's files
 * ("Pull to Hub") and to install a hub skill on disk ("Send to <machine>").
 *
 * Executed on the PC that holds the skill dirs: in-process when that PC is the
 * hub's own machine, otherwise drained through host-reach routing like `cp`.
 * Nothing about the PC is stored on the hub; every answer is computed fresh.
 *
 * Reading one skill out and writing one in are gated by a confirm on the PC
 * (`confirm`), which a host-reach PC also raises on the hub's approvals. The
 * inventory is metadata only (names, descriptions, tree hashes) and is not.
 */
import { realpath } from 'node:fs/promises';
import {
  installCheck,
  installSkillFiles,
  pcSkillsInventory,
  readPcSkill,
  readTar,
  SKILL_NAME_RE,
  uploadBlocker,
  writeTar,
  type InstallOutcome,
  type PcSkillsInventory,
} from '@agentbox/sandbox-core';
import type { HostActionResult } from './types.js';

export const PC_SKILLS_METHODS = [
  'pcskills.inventory',
  'pcskills.export',
  'pcskills.install',
] as const;
export type PcSkillsMethod = (typeof PC_SKILLS_METHODS)[number];

export function isPcSkillsMethod(method: string): method is PcSkillsMethod {
  return (PC_SKILLS_METHODS as readonly string[]).includes(method);
}

/**
 * The box id a device-scoped action is parked under. A `pcskills.*` action
 * belongs to no box; its confirm is listed under this id in the approvals.
 */
export function pcSkillsActionId(deviceId: string): string {
  return `pc:${deviceId}`;
}

/**
 * How long a `pcskills.*` confirm waits on the PC before it counts as a no.
 * A device runs its host-reach actions one at a time, so an unanswered confirm
 * would hold every later action for that PC (the hub's compare included).
 */
export const PC_SKILLS_CONFIRM_TTL_MS = 120_000;

export interface PcSkillsExportParams {
  name: string;
  /** Upload despite secret-scan findings (the user saw them and chose to). */
  allowFindings?: boolean;
}

/** One skill's files read off the PC, for the hub to import. */
export interface PcSkillsExport {
  name: string;
  /** Tree hash of the files: the version id. */
  version: string;
  description: string;
  size: number;
  files: number;
  /** Absolute path it was read from on the PC. */
  path: string;
  /** The gzipped tar, base64. */
  tarball: string;
}

export interface PcSkillsInstallParams {
  name: string;
  version: string;
  /** The gzipped tar, base64. */
  tarball: string;
  overwrite?: boolean;
}

export interface PcSkillsDeps {
  /** The PC's home dir (tests). */
  home?: string;
  /** `skills.maxSkillBytes`. */
  maxBytes?: number;
  /**
   * Ask the PC's owner. Resolves true to go ahead. Absent: no confirm (the hub's
   * own machine, where the click in the hub's UI is the owner's act).
   */
  confirm?: (prompt: { message: string; detail?: string; command: string }) => Promise<boolean>;
  log?: (line: string) => void;
}

const ok = (data: unknown): HostActionResult => ({
  exitCode: 0,
  stdout: JSON.stringify(data),
  stderr: '',
});
const fail = (code: number, msg: string): HostActionResult => ({
  exitCode: code,
  stdout: '',
  stderr: `${msg}\n`,
});

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Run one `pcskills.*` action on this PC. Always resolves with a result. */
export async function executePcSkillsAction(
  method: PcSkillsMethod,
  params: unknown,
  deps: PcSkillsDeps = {},
): Promise<HostActionResult> {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const opts = {
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
  };
  try {
    if (method === 'pcskills.inventory') {
      const inv: PcSkillsInventory = await pcSkillsInventory(opts);
      return ok(inv);
    }
    const name = str(p.name);
    if (!name || !SKILL_NAME_RE.test(name)) {
      return fail(64, 'pcskills: a valid skill name is required');
    }
    if (method === 'pcskills.export') {
      const skill = await readPcSkill(name, opts);
      if (!skill) return fail(66, `no skill '${name}' on this machine`);
      const blocker = uploadBlocker(skill, { allowFindings: p.allowFindings === true });
      if (blocker) return fail(65, `${name}: ${blocker}`);
      if (deps.confirm) {
        const shown = await realpath(skill.dir).catch(() => skill.dir);
        const overridden =
          skill.findings.length > 0
            ? ` · ${String(skill.findings.length)} secret-scan finding(s) overridden (${[
                ...new Set(skill.findings.map((f) => f.rule)),
              ].join(', ')})`
            : '';
        const yes = await deps.confirm({
          message:
            skill.findings.length > 0
              ? `Upload skill ${name} from this machine to the hub's library, despite its secret-scan findings?`
              : `Upload skill ${name} from this machine to the hub's library?`,
          detail: `${shown} · every box on the hub gets it${overridden}`,
          command: method,
        });
        if (!yes) return fail(77, `${name}: declined on this machine`);
      }
      const out: PcSkillsExport = {
        name,
        version: skill.treeSha,
        description: skill.description,
        size: skill.size,
        files: skill.files.length,
        path: skill.dir,
        tarball: writeTar(skill.files).toString('base64'),
      };
      return ok(out);
    }
    // pcskills.install
    const version = str(p.version);
    const tarball = str(p.tarball);
    if (!version || !tarball) return fail(64, 'pcskills.install: version and tarball are required');
    const files = readTar(Buffer.from(tarball, 'base64'), {
      ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
    });
    const home = deps.home ? { home: deps.home } : {};
    const check = await installCheck(name, version, {
      ...home,
      ...(p.overwrite === true ? { overwrite: true } : {}),
    });
    // Ask only when something is written: an identical copy or a refused
    // overwrite needs no one's yes.
    if (deps.confirm && (check.action === 'install' || check.action === 'replace')) {
      const where = check.realTarget ?? check.target;
      const yes = await deps.confirm({
        message:
          check.action === 'replace'
            ? `Replace skill ${name} on this machine with the hub's version?`
            : `Install skill ${name} from the hub on this machine?`,
        detail:
          check.action === 'replace'
            ? `replaces the copy at ${where} with version ${version.slice(0, 12)}`
            : `writes ${where} · version ${version.slice(0, 12)}`,
        command: method,
      });
      if (!yes) return fail(77, `${name}: declined on this machine`);
    }
    const res: InstallOutcome = await installSkillFiles(name, files, version, {
      ...home,
      ...(p.overwrite === true ? { overwrite: true } : {}),
    });
    deps.log?.(`pcskills: ${name} ${res.status}`);
    return ok(res);
  } catch (err) {
    return fail(1, `${method}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
