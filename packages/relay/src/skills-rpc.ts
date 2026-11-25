/**
 * `skills.get` / `skills.blob`: how a box pulls its share of the hub's skills
 * library (docs/hub-skills-plan.md, Phase 2).
 *
 * The library lives in the custody `skills` scope the hub's `/api/v1/skills`
 * routes write (`apps/hub/lib/backend/skills.ts`):
 *
 *   skills/<name>/meta.json          { current, versions: [{ sha256, tarballBytes, ... }] }
 *   skills/<name>/<treeSha>.tar.gz   one normalized tree per version
 *   skills/.seeded                   written by the first import
 *   skills/.skipped.json             names never delivered (`readSkips`)
 *
 * The meta reader is duplicated here, not imported: the hub's slice is bundled
 * into Next routes and can't be a relay dependency, and the relay can't import
 * the hub. `test/skills-rpc.test.ts` pins this reader to that layout.
 *
 * Box-scoped: a box sees only the skills its selection resolves to, and
 * `skills.blob` refuses any (name, version) outside that set, so a box can't
 * enumerate or read the rest of the library. Unprompted and not worktree-scoped,
 * like `agents.list` and `history.*`.
 */
import { repoKey } from '@agentbox/config';
import type { CustodyStore } from './custody/store.js';
import { readWorkspaceForBox } from './workspaces/timeline-store.js';
import type { BoxWorkspaceKey } from './workspaces/workspace-store.js';
import {
  hasWorkspaceBindings,
  readBindings,
  readSkips,
  resolveSkillNames,
  type SkillBindingContext,
} from '@agentbox/core';
import type { BoxRegistration, HostActionResult, SkillSelection } from './types.js';

/**
 * Who is asking, for the bindings (Phase 4). Built from the box's REGISTRATION
 * by the relay, never from the box's own params. The workspace is looked up
 * lazily: it costs a read of every workspace record, and most libraries bind
 * nothing per workspace.
 */
export interface BoxSkillContext {
  boxId?: string;
  projectKey?: string;
  workspaceId?: () => Promise<string | undefined>;
}

const SCOPE = 'skills';
const SEEDED = `${SCOPE}/.seeded`;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/**
 * Raw bytes per `skills.blob` answer. A cloud box's RPC answer travels back
 * through the bridge as JSON with a 1 MiB body cap; 512 KiB of base64 is
 * ~683 KiB, leaving room for the envelope.
 */
export const SKILL_BLOB_CHUNK_BYTES = 512 * 1024;

export interface BoxSkill {
  name: string;
  /** Tree hash of the version to install. */
  version: string;
  /** Tarball bytes, so the box knows how many chunks to ask for. */
  bytes: number;
}

export interface SkillsGetResult {
  /** False when this relay holds no library (no custody, or never seeded): the box changes nothing. */
  library: boolean;
  skills: BoxSkill[];
}

interface MetaVersion {
  sha256?: unknown;
  tarballBytes?: unknown;
}
interface Meta {
  current?: unknown;
  versions?: unknown;
}

/**
 * The bindings context of a registered box. The project is its repo key (the
 * registering PC's alias-expanded one when it sent it); the workspace is the
 * one the box's origin folder (on its origin machine) or its repo belongs to,
 * the same join the timeline uses. All of it is machine-independent, so the
 * same repo from two PCs resolves to the same bindings.
 */
export function skillContextForRegistration(
  reg: Pick<
    BoxRegistration,
    | 'boxId'
    | 'repoKey'
    | 'originUrl'
    | 'originMachineId'
    | 'originMachineLabel'
    | 'originFolder'
    | 'worktrees'
  >,
): BoxSkillContext {
  const projectKey = reg.repoKey ?? repoKey(reg.originUrl);
  const key: BoxWorkspaceKey = {
    ...(reg.originUrl ? { originUrl: reg.originUrl } : {}),
  };
  if (reg.originFolder && reg.originMachineId) {
    key.projectRoot = reg.originFolder;
    key.host = { id: reg.originMachineId, label: reg.originMachineLabel ?? '' };
  } else if (reg.worktrees?.[0]?.hostMainRepo) {
    // A docker box: its worktree's main repo is a folder on this relay's machine.
    key.projectRoot = reg.worktrees[0].hostMainRepo;
  }
  return {
    boxId: reg.boxId,
    ...(projectKey ? { projectKey } : {}),
    workspaceId: async () => (await readWorkspaceForBox(key))?.id,
  };
}

/** Parse a create-flag selection off an untrusted wire body. Undefined = every skill. */
export function parseSkillSelection(raw: unknown): SkillSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const names = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((n): n is string => typeof n === 'string' && NAME_RE.test(n))
      : undefined;
  const out: SkillSelection = {};
  if (r.none === true) out.none = true;
  const include = names(r.include);
  if (include) out.include = include;
  const exclude = names(r.exclude);
  if (exclude) out.exclude = exclude;
  return Object.keys(out).length > 0 ? out : undefined;
}

async function readMeta(custody: CustodyStore, name: string): Promise<Meta | null> {
  const found = await custody.get(`${SCOPE}/${name}/meta.json`).catch(() => null);
  if (!found) return null;
  try {
    return JSON.parse(found.data.toString('utf8')) as Meta;
  } catch {
    return null;
  }
}

/** The box's resolved set: each selected skill at the library's current version. */
export async function resolveBoxSkills(
  custody: CustodyStore | null | undefined,
  selection: SkillSelection | undefined,
  box: BoxSkillContext = {},
): Promise<SkillsGetResult> {
  if (!custody) return { library: false, skills: [] };
  const entries = await custody.list(SCOPE);
  if (!entries.some((e) => e.path === SEEDED)) return { library: false, skills: [] };
  const names = new Set<string>();
  for (const e of entries) {
    const m = /^skills\/([^/]+)\/meta\.json$/.exec(e.path);
    if (m && NAME_RE.test(m[1]!)) names.add(m[1]!);
  }
  // A skipped skill is never delivered, whatever the bindings or create flags say.
  const skips = await readSkips(custody);
  for (const n of Object.keys(skips.skipped)) names.delete(n);
  const bindings = await readBindings(custody);
  const ctx: SkillBindingContext = {
    ...(box.boxId ? { boxId: box.boxId } : {}),
    ...(box.projectKey ? { projectKey: box.projectKey } : {}),
  };
  if (box.workspaceId && hasWorkspaceBindings(bindings)) {
    const ws = await box.workspaceId().catch(() => undefined);
    if (ws) ctx.workspaceId = ws;
  }
  const skills: BoxSkill[] = [];
  for (const name of resolveSkillNames([...names].sort(), bindings, ctx, selection)) {
    const meta = await readMeta(custody, name);
    if (!meta || typeof meta.current !== 'string' || !SHA_RE.test(meta.current)) continue;
    const versions = Array.isArray(meta.versions) ? (meta.versions as MetaVersion[]) : [];
    const cur = versions.find((v) => v.sha256 === meta.current);
    const bytes = typeof cur?.tarballBytes === 'number' ? cur.tarballBytes : 0;
    skills.push({ name, version: meta.current, bytes });
  }
  return { library: true, skills };
}

/**
 * Where the relay records the set it last served a box: `{at, skills: {name:
 * version}}`. The hub compares it with each skill's current version to tell a
 * box that is `behind` (it slept through an update, or its sync failed) and to
 * pick the boxes an update should reach (docs/hub-skills-plan.md, Phase 5).
 */
export function boxSkillsRecordPath(boxId: string): string {
  return `boxes/${boxId}/skills.json`;
}

export interface BoxSkillsRecord {
  at: string;
  skills: Record<string, string>;
}

const BOX_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

async function recordServed(
  custody: CustodyStore,
  boxId: string,
  set: SkillsGetResult,
  now: Date,
): Promise<void> {
  if (!BOX_ID_RE.test(boxId) || boxId === '.' || boxId === '..') return;
  const skills: Record<string, string> = {};
  for (const s of set.skills) skills[s.name] = s.version;
  const path = boxSkillsRecordPath(boxId);
  // Content-skip: an unchanged set rewrites nothing, so `at` is when the set
  // last CHANGED, not the last boot.
  const prev = await custody.get(path).catch(() => null);
  if (prev) {
    try {
      const old = JSON.parse(prev.data.toString('utf8')) as BoxSkillsRecord;
      if (JSON.stringify(old.skills) === JSON.stringify(skills)) return;
    } catch {
      // rewrite a corrupt record
    }
  }
  const body: BoxSkillsRecord = { at: now.toISOString(), skills };
  await custody.put(path, Buffer.from(JSON.stringify(body), 'utf8'));
}

function ok(payload: unknown): HostActionResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
}
function refuse(message: string): HostActionResult {
  return { exitCode: 1, stdout: '', stderr: `skills: ${message}\n` };
}

/**
 * Serve one `skills.*` RPC for a box. `selection` comes from the box's
 * REGISTRATION (set at create by the host), never from the box's own params.
 */
export async function runSkillsRpc(
  custody: CustodyStore | null | undefined,
  selection: SkillSelection | undefined,
  method: string,
  params: unknown,
  box: BoxSkillContext & { now?: Date } = {},
): Promise<HostActionResult> {
  try {
    if (method === 'skills.get') {
      const set = await resolveBoxSkills(custody, selection, box);
      if (custody && set.library && box.boxId) {
        // Best-effort: losing the record only hides `behind`; never fail the box's pull.
        await recordServed(custody, box.boxId, set, box.now ?? new Date()).catch(() => undefined);
      }
      return ok(set);
    }
    if (method === 'skills.blob') {
      const p = (params ?? {}) as { name?: unknown; version?: unknown; offset?: unknown };
      if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) return refuse('bad name');
      if (typeof p.version !== 'string' || !SHA_RE.test(p.version)) return refuse('bad version');
      const offset =
        typeof p.offset === 'number' && Number.isInteger(p.offset) && p.offset >= 0 ? p.offset : -1;
      if (offset < 0) return refuse('bad offset');
      const set = await resolveBoxSkills(custody, selection, box);
      if (!set.skills.some((s) => s.name === p.name && s.version === p.version)) {
        return refuse(`${p.name}@${p.version.slice(0, 12)} is not in this box's skill set`);
      }
      const path = `${SCOPE}/${p.name}/${p.version}.tar.gz`;
      let chunk: { data: Buffer; size: number } | null;
      if (custody!.readRange) {
        chunk = await custody!.readRange(path, offset, SKILL_BLOB_CHUNK_BYTES);
      } else {
        const whole = await custody!.get(path);
        chunk = whole
          ? {
              data: whole.data.subarray(offset, offset + SKILL_BLOB_CHUNK_BYTES),
              size: whole.entry.size,
            }
          : null;
      }
      if (!chunk) return refuse(`${p.name}@${p.version.slice(0, 12)} has no stored tarball`);
      return ok({
        data: chunk.data.toString('base64'),
        size: chunk.size,
        eof: offset + chunk.data.length >= chunk.size,
      });
    }
    return refuse(`unknown method ${method}`);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}
