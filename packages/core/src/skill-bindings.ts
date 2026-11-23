/**
 * Skill bindings: which library skills a box gets, narrowed or widened per
 * workspace, project (repo key) and box (docs/hub-skills-plan.md, Phase 4).
 *
 * Kept as ONE custody file next to the library it selects from:
 *
 *   skills/.bindings.json   { schema: 1, global, workspace, project, box }
 *
 * The relay reads it to answer `skills.get`; the hub's `/api/v1/skill-bindings`
 * routes write it. A project is keyed by its repo key (`repoKey` in
 * `@agentbox/config`), never a folder, so the same repo from two PCs resolves
 * to the same bindings.
 *
 * Resolution, per library skill, most specific first: box > project >
 * workspace > global; no binding at all = included (every imported skill is in
 * the default set). The create flags (`SkillSelection`) are more specific
 * still and applied last, see {@link resolveSkillNames}.
 */
import type { SkillSelection } from './box-record.js';

export type SkillBindingScope = 'global' | 'workspace' | 'project' | 'box';
export type SkillBindingMode = 'include' | 'exclude';

export const SKILL_BINDING_SCOPES: readonly SkillBindingScope[] = [
  'global',
  'workspace',
  'project',
  'box',
];

export const SKILL_BINDINGS_PATH = 'skills/.bindings.json';

/** skill name → mode. */
export type SkillBindingMap = Record<string, SkillBindingMode>;

export interface SkillBindingsDoc {
  schema: 1;
  global: SkillBindingMap;
  workspace: Record<string, SkillBindingMap>;
  project: Record<string, SkillBindingMap>;
  box: Record<string, SkillBindingMap>;
}

/** Where a box's decision about one skill came from. */
export type SkillDecisionSource = SkillBindingScope | 'default' | 'flags';

export interface SkillBindingContext {
  boxId?: string;
  /** Repo key of the box's project. */
  projectKey?: string;
  workspaceId?: string;
}

export interface ResolvedSkill {
  name: string;
  included: boolean;
  from: SkillDecisionSource;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKSPACE_ID_RE = /^[0-9a-f]{16}$/;
const BOX_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function emptyBindings(): SkillBindingsDoc {
  return { schema: 1, global: {}, workspace: {}, project: {}, box: {} };
}

/** Why a scope id is unusable, or null. The global scope takes no id. */
export function scopeIdProblem(
  scope: SkillBindingScope,
  scopeId: string | undefined,
): string | null {
  if (scope === 'global') return scopeId ? 'the global scope takes no scopeId' : null;
  if (!scopeId) return `scope '${scope}' needs a scopeId`;
  if (scope === 'workspace' && !WORKSPACE_ID_RE.test(scopeId)) {
    return `workspace scopeId must be a 16-hex workspace id`;
  }
  if (scope === 'box' && !BOX_ID_RE.test(scopeId)) return 'invalid box id';
  if (scope === 'project') {
    // A repo key: `host/owner/repo` (or `local:<machine>:<path>`). Printable,
    // bounded; the hub never derives anything from it beyond equality.
    if (scopeId.length > 512 || /[\u0000-\u001f\u007f\s]/.test(scopeId)) {
      return 'project scopeId must be a repo key (e.g. github.com/owner/repo)';
    }
  }
  return null;
}

function parseMap(raw: unknown): SkillBindingMap {
  const out: SkillBindingMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (NAME_RE.test(name) && (mode === 'include' || mode === 'exclude')) out[name] = mode;
  }
  return out;
}

function parseKeyed(raw: unknown, scope: SkillBindingScope): Record<string, SkillBindingMap> {
  const out: Record<string, SkillBindingMap> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, map] of Object.entries(raw as Record<string, unknown>)) {
    if (scopeIdProblem(scope, id)) continue;
    const m = parseMap(map);
    if (Object.keys(m).length > 0) out[id] = m;
  }
  return out;
}

/** Parse the stored file; anything malformed is dropped, never thrown. */
export function parseBindings(raw: unknown): SkillBindingsDoc {
  if (!raw || typeof raw !== 'object') return emptyBindings();
  const r = raw as Record<string, unknown>;
  return {
    schema: 1,
    global: parseMap(r.global),
    workspace: parseKeyed(r.workspace, 'workspace'),
    project: parseKeyed(r.project, 'project'),
    box: parseKeyed(r.box, 'box'),
  };
}

/** The structural custody slice bindings need (`FsCustodyStore` satisfies it). */
export interface BindingsStore {
  get(path: string): Promise<{ data: Buffer } | null>;
  put(path: string, data: Buffer): Promise<unknown>;
}

export async function readBindings(store: BindingsStore): Promise<SkillBindingsDoc> {
  const found = await store.get(SKILL_BINDINGS_PATH).catch(() => null);
  if (!found) return emptyBindings();
  try {
    return parseBindings(JSON.parse(found.data.toString('utf8')));
  } catch {
    return emptyBindings();
  }
}

/** One scope's map (empty when nothing is bound there). */
export function bindingsAt(
  doc: SkillBindingsDoc,
  scope: SkillBindingScope,
  scopeId?: string,
): SkillBindingMap {
  if (scope === 'global') return doc.global;
  return (scopeId ? doc[scope][scopeId] : undefined) ?? {};
}

/**
 * Merge `changes` into one scope: a mode sets it, `null` clears it (the skill
 * inherits from the next scope down again). Pure; returns a new doc.
 */
export function applyBindingChanges(
  doc: SkillBindingsDoc,
  scope: SkillBindingScope,
  scopeId: string | undefined,
  changes: Record<string, SkillBindingMode | null>,
): SkillBindingsDoc {
  const next: SkillBindingsDoc = {
    schema: 1,
    global: { ...doc.global },
    workspace: { ...doc.workspace },
    project: { ...doc.project },
    box: { ...doc.box },
  };
  const map: SkillBindingMap = { ...bindingsAt(doc, scope, scopeId) };
  for (const [name, mode] of Object.entries(changes)) {
    if (mode === null) delete map[name];
    else map[name] = mode;
  }
  if (scope === 'global') next.global = map;
  else if (scopeId) {
    if (Object.keys(map).length > 0) next[scope][scopeId] = map;
    else delete next[scope][scopeId];
  }
  return next;
}

/** Drop every binding naming `name` (the skill was discarded from the library). */
export function withoutSkill(doc: SkillBindingsDoc, name: string): SkillBindingsDoc {
  let next = doc;
  for (const scope of SKILL_BINDING_SCOPES) {
    if (scope === 'global') {
      if (name in next.global)
        next = applyBindingChanges(next, 'global', undefined, { [name]: null });
      continue;
    }
    for (const id of Object.keys(next[scope])) {
      if (name in next[scope][id]!) next = applyBindingChanges(next, scope, id, { [name]: null });
    }
  }
  return next;
}

/** Bindings alone: per library skill, the most specific binding, else included. */
export function resolveBindings(
  names: readonly string[],
  doc: SkillBindingsDoc,
  ctx: SkillBindingContext,
): ResolvedSkill[] {
  const layers: [SkillBindingScope, SkillBindingMap][] = [
    ['box', ctx.boxId ? (doc.box[ctx.boxId] ?? {}) : {}],
    ['project', ctx.projectKey ? (doc.project[ctx.projectKey] ?? {}) : {}],
    ['workspace', ctx.workspaceId ? (doc.workspace[ctx.workspaceId] ?? {}) : {}],
    ['global', doc.global],
  ];
  return names.map((name) => {
    for (const [scope, map] of layers) {
      const mode = map[name];
      if (mode) return { name, included: mode === 'include', from: scope };
    }
    return { name, included: true, from: 'default' as const };
  });
}

/**
 * The full resolution: bindings, then the box's create flags on top, which are
 * the most specific choice there is. `--no-skills` → none; `--skills a,b` →
 * exactly those (an explicit list overrides any binding); `--skip-skills`
 * subtracts from the bound set.
 */
export function resolveSkillDecisions(
  names: readonly string[],
  doc: SkillBindingsDoc,
  ctx: SkillBindingContext,
  selection: SkillSelection | undefined,
): ResolvedSkill[] {
  const bound = resolveBindings(names, doc, ctx);
  if (!selection) return bound;
  const include = selection.include ? new Set(selection.include) : null;
  const exclude = new Set(selection.exclude ?? []);
  return bound.map((r) => {
    if (selection.none) return { ...r, included: false, from: 'flags' as const };
    if (include) return { ...r, included: include.has(r.name), from: 'flags' as const };
    if (exclude.has(r.name)) return { ...r, included: false, from: 'flags' as const };
    return r;
  });
}

export function resolveSkillNames(
  names: readonly string[],
  doc: SkillBindingsDoc,
  ctx: SkillBindingContext,
  selection: SkillSelection | undefined,
): string[] {
  return resolveSkillDecisions(names, doc, ctx, selection)
    .filter((r) => r.included)
    .map((r) => r.name);
}

/** True when any workspace binding exists (so a caller can skip the workspace lookup). */
export function hasWorkspaceBindings(doc: SkillBindingsDoc): boolean {
  return Object.keys(doc.workspace).length > 0;
}
