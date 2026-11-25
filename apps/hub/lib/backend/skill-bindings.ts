// Skill bindings: which library skills a box gets per workspace, project (repo
// key) and box (docs/hub-skills-plan.md, Phase 4). Stored as one custody file,
// `skills/.bindings.json`, which the relay reads to answer a box's `skills.get`;
// the file format and the resolution rule live in @agentbox/core
// (`skill-bindings.ts`) so the routes here and the relay can't drift.
//
// Pure over the same structural custody slice as the library (`SkillsStore`).
import { repoKey } from '@agentbox/config';
import {
  SKILL_BINDINGS_PATH,
  SKILL_BINDING_SCOPES,
  applyBindingChanges,
  bindingsAt,
  readBindings,
  resolveBindings,
  scopeIdProblem,
  type SkillBindingMap,
  type SkillBindingMode,
  type SkillBindingScope,
  type SkillBindingsDoc,
  type SkillDecisionSource,
} from '@agentbox/core';
import { listSkills, skillNameProblem, SkillsError, type SkillsStore } from './skills';

export type { SkillBindingMap, SkillBindingMode, SkillBindingScope, SkillBindingsDoc };

export interface BindingTarget {
  scope: SkillBindingScope;
  scopeId?: string;
}

/** Validate `?scope&scopeId`. Throws `invalid_request`. */
export function parseBindingTarget(scope: string | null, scopeId: string | null): BindingTarget {
  if (!scope || !(SKILL_BINDING_SCOPES as readonly string[]).includes(scope)) {
    throw new SkillsError(
      'invalid_request',
      `scope must be one of ${SKILL_BINDING_SCOPES.join(' | ')}`,
    );
  }
  const s = scope as SkillBindingScope;
  const id = scopeId && scopeId.length > 0 ? scopeId : undefined;
  const problem = scopeIdProblem(s, id);
  if (problem) throw new SkillsError('invalid_request', problem);
  return { scope: s, ...(id ? { scopeId: id } : {}) };
}

/** Validate a PUT body: `{ bindings: { <name>: 'include' | 'exclude' | null } }`. */
export function parseBindingChanges(raw: unknown): Record<string, SkillBindingMode | null> {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const b = body?.bindings;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new SkillsError(
      'invalid_request',
      "body must be { bindings: { <skill>: 'include' | 'exclude' | null } }",
    );
  }
  const out: Record<string, SkillBindingMode | null> = {};
  for (const [name, mode] of Object.entries(b as Record<string, unknown>)) {
    const problem = skillNameProblem(name);
    if (problem) throw new SkillsError('invalid_request', problem);
    if (mode !== 'include' && mode !== 'exclude' && mode !== null) {
      throw new SkillsError(
        'invalid_request',
        `${name}: mode must be 'include', 'exclude' or null`,
      );
    }
    out[name] = mode;
  }
  if (Object.keys(out).length === 0) {
    throw new SkillsError('invalid_request', 'bindings is empty');
  }
  return out;
}

export async function getSkillBindings(store: SkillsStore): Promise<SkillBindingsDoc> {
  return readBindings(store);
}

// One writer at a time per hub process: every write is read-modify-write of one
// file. Kept on globalThis because Next can load this module more than once.
const g = globalThis as { __AGENTBOX_SKILL_BINDINGS_CHAIN?: Promise<unknown> };

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__AGENTBOX_SKILL_BINDINGS_CHAIN ?? Promise.resolve();
  const run = prev.then(fn, fn);
  g.__AGENTBOX_SKILL_BINDINGS_CHAIN = run.catch(() => undefined);
  return run;
}

async function writeBindings(store: SkillsStore, doc: SkillBindingsDoc): Promise<void> {
  await store.put(SKILL_BINDINGS_PATH, Buffer.from(JSON.stringify(doc, null, 2), 'utf8'));
}

/** Merge changes into one scope; returns that scope's map after the write. */
export function putSkillBindings(
  store: SkillsStore,
  target: BindingTarget,
  changes: Record<string, SkillBindingMode | null>,
): Promise<SkillBindingMap> {
  return serialized(async () => {
    const next = applyBindingChanges(
      await readBindings(store, { strict: true }),
      target.scope,
      target.scopeId,
      changes,
    );
    await writeBindings(store, next);
    return bindingsAt(next, target.scope, target.scopeId);
  });
}

export interface PreviewSkill {
  name: string;
  description: string;
  included: boolean;
  from: SkillDecisionSource;
}

export interface SkillSetPreview {
  /** False when the library was never seeded: boxes keep the carried skills. */
  library: boolean;
  /** The repo key the preview used for the project scope, when a repo was given. */
  projectKey?: string;
  skills: PreviewSkill[];
}

/**
 * The set a new box would get from the bindings alone (before any create
 * flags), for a project given as a repo URL or key, in an optional workspace.
 * The hub has no `~/.ssh/config` aliases for the PC's remotes, so an aliased
 * scp-style URL keys here as written; the CLI sends the expanded key instead.
 */
export async function previewSkillSet(
  store: SkillsStore,
  input: { repo?: string; projectKey?: string; workspaceId?: string; boxId?: string },
): Promise<SkillSetPreview> {
  const listing = await listSkills(store);
  const projectKey = input.projectKey ?? (input.repo ? repoKey(input.repo) : undefined);
  if (!listing.seeded) return { library: false, ...(projectKey ? { projectKey } : {}), skills: [] };
  const doc = await readBindings(store);
  const skipped = new Set(listing.skipped);
  const decided = resolveBindings(
    listing.skills.map((s) => s.name).filter((n) => !skipped.has(n)),
    doc,
    {
      ...(input.boxId ? { boxId: input.boxId } : {}),
      ...(projectKey ? { projectKey } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
  );
  const desc = new Map(listing.skills.map((s) => [s.name, s.description]));
  return {
    library: true,
    ...(projectKey ? { projectKey } : {}),
    skills: decided.map((d) => ({ ...d, description: desc.get(d.name) ?? '' })),
  };
}

/**
 * Give box `to` the box-scope bindings box `from` has (a clone keeps the skills
 * its source was bound to). A no-op when `from` has none. Returns how many.
 */
export function copyBoxBindings(store: SkillsStore, from: string, to: string): Promise<number> {
  return serialized(async () => {
    const doc = await readBindings(store, { strict: true });
    const source = bindingsAt(doc, 'box', from);
    const names = Object.keys(source);
    if (names.length === 0) return 0;
    await writeBindings(store, applyBindingChanges(doc, 'box', to, { ...source }));
    return names.length;
  });
}

/**
 * Wait for a clone's create job to name its box, then copy the source box's
 * box-scope bindings to it. The box id only exists once the worker has built
 * the box, so this runs after the route answered. Best-effort: a failed or
 * timed-out create copies nothing, and an error is logged, never thrown.
 */
export async function copyBoxBindingsWhenCreated(args: {
  store: SkillsStore;
  fromBoxId: string;
  getJob: (id: string) => Promise<{ status: string; boxId?: string } | null>;
  jobId: string;
  log?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const pollMs = args.pollMs ?? 2_000;
  const deadline = Date.now() + (args.timeoutMs ?? 60 * 60_000);
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    // Nothing to wait for when the source has no box bindings.
    const doc = await readBindings(args.store);
    if (Object.keys(bindingsAt(doc, 'box', args.fromBoxId)).length === 0) return 0;
    while (Date.now() < deadline) {
      const job = await args.getJob(args.jobId).catch(() => null);
      if (job?.boxId) return await copyBoxBindings(args.store, args.fromBoxId, job.boxId);
      if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return 0;
      await sleep(pollMs);
    }
    args.log?.(`skills: clone job ${args.jobId} never named its box; box bindings not copied`);
    return 0;
  } catch (err) {
    args.log?.(
      `skills: copying box bindings from ${args.fromBoxId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
