/**
 * Moving skills between this PC and the hub's library: compare, upload, the
 * automatic first seed, and download (docs/hub-skills-plan.md, Phase 1).
 *
 * Everything goes through the hub's `/api/v1/skills` (the CLI never touches
 * custody directly), so a local hub and a remote control box behave the same.
 */
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import {
  HubApiError,
  type HubApiClient,
  type HubApiSkill,
} from '../../control-plane/hub-api-client.js';
import {
  compareSkills as compareShared,
  discoverLocalSkills,
  installSkillFiles,
  readTar,
  writeTar,
  type CompareRow,
  type InstallOutcome,
  type LocalSkill,
  type SkillRowStatus,
  uploadBlocker,
} from '@agentbox/sandbox-core';

export { agentsSkillDir, uploadBlocker } from '@agentbox/sandbox-core';
export type { SkillRowStatus };

export interface SkillsContext {
  home: string;
  /** `skills.maxSkillBytes`. */
  maxBytes: number;
  /** The control box's admin token, when this PC holds it (skill downloads are elevated). */
  adminToken?: string;
}

export type SkillRow = CompareRow<LocalSkill, HubApiSkill>;

/**
 * Local and hub skills side by side, matched by name (the shared comparison).
 * A name in `skipped` (the hub's "never sync" list) is `skipped`.
 */
export function compareSkills(
  local: readonly LocalSkill[],
  hub: readonly HubApiSkill[],
  skipped: Iterable<string> = [],
): SkillRow[] {
  return compareShared(local, hub, skipped);
}

export type UploadOutcome =
  | { name: string; status: 'uploaded' | 'unchanged'; version: string }
  | { name: string; status: 'skipped'; reason: string };

export async function uploadLocalSkill(
  client: HubApiClient,
  skill: LocalSkill,
  opts: { allowFindings?: boolean; linked?: boolean } = {},
): Promise<UploadOutcome> {
  const blocker = uploadBlocker(skill, opts);
  if (blocker) return { name: skill.name, status: 'skipped', reason: blocker };
  const res = await client.uploadSkill(skill.name, writeTar(skill.files), {
    sha256: skill.treeSha,
    description: skill.description,
    size: skill.size,
    files: skill.files.length,
    source: {
      host: getMachineLabel(),
      ...(tryGetMachineId() ? { machineId: tryGetMachineId()! } : {}),
      path: skill.dir,
    },
    ...(opts.linked ? { linked: true } : {}),
  });
  return { name: skill.name, status: res.changed ? 'uploaded' : 'unchanged', version: res.version };
}

/** The hub's 409 for a skill marked "never sync" (`error.details.reason: 'skipped'`). */
export function isSkippedRefusal(err: unknown): boolean {
  if (!(err instanceof HubApiError) || err.status !== 409 || err.code !== 'conflict') return false;
  const d = err.details as { reason?: unknown } | undefined;
  return d?.reason === 'skipped';
}

export interface SeedOutcome {
  uploaded: string[];
  skipped: { name: string; reason: string }[];
  /** Uploads that failed on the wire (the rest still went). */
  failed: { name: string; reason: string }[];
}

/**
 * The automatic first seed (owner direction 2): when the hub has never held a
 * skill, upload every clean local skill. Flagged or invalid skills are skipped
 * and named; a skill the hub marks skipped ("never sync") is left out without a
 * word. Returns null when the hub is already seeded — after the first seed,
 * adding a skill is always an explicit action.
 */
export async function seedSkillsIfEmpty(
  client: HubApiClient,
  ctx: SkillsContext,
  /** This PC's skills when the caller already discovered them. */
  discovered?: LocalSkill[],
): Promise<SeedOutcome | null> {
  const listing = await client.listSkills();
  if (listing.seeded) return null;
  const never = new Set(listing.skipped ?? []);
  const local = (
    discovered ?? (await discoverLocalSkills({ home: ctx.home, maxBytes: ctx.maxBytes }))
  ).filter((s) => !never.has(s.name));
  const out: SeedOutcome = { uploaded: [], skipped: [], failed: [] };
  for (const skill of local) {
    try {
      const r = await uploadLocalSkill(client, skill);
      if (r.status === 'skipped') out.skipped.push({ name: r.name, reason: r.reason });
      else out.uploaded.push(r.name);
    } catch (err) {
      // Skipped on the hub after the listing above: intended, not a failure.
      if (isSkippedRefusal(err)) continue;
      out.failed.push({
        name: skill.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** One line for a seed result, for the setup step and the create path. */
export function describeSeed(o: SeedOutcome): string {
  const parts = [
    `seeded the hub's skills library with ${String(o.uploaded.length)} skill(s) from this PC`,
  ];
  if (o.skipped.length > 0) {
    parts.push(
      `skipped ${String(o.skipped.length)} (${o.skipped.map((s) => s.name).join(', ')}) — review with \`agentbox skills\``,
    );
  }
  if (o.failed.length > 0)
    parts.push(`${String(o.failed.length)} failed (${o.failed.map((s) => s.name).join(', ')})`);
  return parts.join('; ');
}

export type DownloadOutcome = InstallOutcome;

/**
 * Install a hub skill on this PC at `~/.agents/skills/<name>` (plus a link for
 * agents that don't read it). The tarball's tree hash is re-derived and must
 * match the version the hub named, so what lands is exactly what was uploaded.
 * An existing local skill with different content is replaced only with
 * `overwrite`.
 */
export async function downloadHubSkill(
  client: HubApiClient,
  name: string,
  ctx: SkillsContext,
  opts: { overwrite?: boolean; version?: string } = {},
): Promise<DownloadOutcome> {
  const got = await client.downloadSkill(name, opts.version, {
    ...(ctx.adminToken ? { adminToken: ctx.adminToken } : {}),
  });
  const files = readTar(got.data, { maxBytes: ctx.maxBytes });
  if (!/^[0-9a-f]{64}$/.test(got.version)) {
    throw new Error(`skill '${name}': the hub did not name the version it sent`);
  }
  return installSkillFiles(name, files, got.version, {
    home: ctx.home,
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
}
