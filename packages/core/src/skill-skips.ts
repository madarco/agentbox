/**
 * Skipped skills: names the owner unticked on Settings > Skills ("never sync
 * this skill"). Kept as one custody file next to the library and its bindings:
 *
 *   skills/.skipped.json   { schema: 1, skipped: { <name>: { at } } }
 *
 * Keyed by NAME, not by a library entry, so a skill that exists only on a PC
 * can be skipped before the hub ever holds it. A skip is absolute, unlike a
 * global `exclude` binding (which a box or project `include`, or `--skills`,
 * overrides): a skipped skill is never delivered to a box, never imported from
 * a PC (first seed, upload, pull) and never sent to one. Skipping never deletes
 * the skill from the library or the PC; unskipping undoes it.
 */
import type { BindingsStore } from './skill-bindings.js';

export const SKILL_SKIPS_PATH = 'skills/.skipped.json';

export interface SkillSkip {
  /** When it was skipped (ISO). */
  at: string;
}

export interface SkillSkipsDoc {
  schema: 1;
  skipped: Record<string, SkillSkip>;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function emptySkips(): SkillSkipsDoc {
  return { schema: 1, skipped: Object.create(null) as Record<string, SkillSkip> };
}

/** Parse the stored file; anything malformed is dropped, never thrown. */
export function parseSkips(raw: unknown): SkillSkipsDoc {
  const out = emptySkips();
  if (!raw || typeof raw !== 'object') return out;
  const skipped = (raw as Record<string, unknown>).skipped;
  if (!skipped || typeof skipped !== 'object' || Array.isArray(skipped)) return out;
  for (const [name, v] of Object.entries(skipped as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) continue;
    const at = v && typeof v === 'object' ? (v as Record<string, unknown>).at : undefined;
    out.skipped[name] = { at: typeof at === 'string' ? at : '' };
  }
  return out;
}

/**
 * The skips file exists but can't be read or parsed. Every reader fails closed
 * on it: "nothing skipped" would deliver, upload, pull and send every skipped
 * skill on one transient read error or one hand-broken file.
 */
export class SkillSkipsUnreadableError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      `${SKILL_SKIPS_PATH} can't be read (${detail}); skipped skills can't be told apart until it is fixed or deleted`,
      options,
    );
    this.name = 'SkillSkipsUnreadableError';
  }
}

/**
 * Read the stored skips. A missing file is "nothing skipped"; a file that
 * exists but can't be read, isn't JSON or isn't a skips document throws
 * {@link SkillSkipsUnreadableError} (fail closed).
 */
export async function readSkips(store: Pick<BindingsStore, 'get'>): Promise<SkillSkipsDoc> {
  let found: { data: Buffer } | null;
  try {
    found = await store.get(SKILL_SKIPS_PATH);
  } catch (err) {
    throw new SkillSkipsUnreadableError(err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
  if (!found) return emptySkips();
  let raw: unknown;
  try {
    raw = JSON.parse(found.data.toString('utf8'));
  } catch (err) {
    throw new SkillSkipsUnreadableError('not valid JSON', { cause: err });
  }
  const skipped =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).skipped : undefined;
  if (!skipped || typeof skipped !== 'object' || Array.isArray(skipped)) {
    throw new SkillSkipsUnreadableError('no `skipped` object');
  }
  return parseSkips(raw);
}

/** The skipped names, sorted. */
export function skippedNames(doc: SkillSkipsDoc): string[] {
  return Object.keys(doc.skipped).sort();
}

/** Skip (`true`) or unskip (`false`) one name. Pure; returns a new doc. */
export function applySkip(
  doc: SkillSkipsDoc,
  name: string,
  skip: boolean,
  now: Date = new Date(),
): SkillSkipsDoc {
  const next = emptySkips();
  Object.assign(next.skipped, doc.skipped);
  if (skip) {
    if (!Object.hasOwn(next.skipped, name)) next.skipped[name] = { at: now.toISOString() };
  } else {
    delete next.skipped[name];
  }
  return next;
}

/** Whether `name` is a valid skill name a skip can hold. */
export function isSkippableName(name: string): boolean {
  return NAME_RE.test(name);
}
