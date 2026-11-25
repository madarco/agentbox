// Skipped skills (Settings > Skills "Sync" column): names the owner marked
// "never sync". Stored in `skills/.skipped.json` next to the library
// (@agentbox/core `skill-skips`), so the relay's `skills.get`, the PC
// comparison, pull, send and every PC upload read the same list. Skipping never
// deletes a skill from the library or a PC.
import {
  applySkip,
  isSkippableName,
  readSkips,
  SKILL_SKIPS_PATH,
  skippedNames,
  type SkillSkipsDoc,
} from '@agentbox/core';
import { SkillsError, type SkillsStore } from './skills';

export interface SkippedSkill {
  name: string;
  at: string;
}

function rows(doc: SkillSkipsDoc): SkippedSkill[] {
  return Object.keys(doc.skipped)
    .sort()
    .map((name) => ({ name, at: doc.skipped[name]!.at }));
}

export async function listSkippedSkills(store: SkillsStore): Promise<SkippedSkill[]> {
  return rows(await readSkips(store));
}

/** The skipped names as a set (a failed or corrupt read is "nothing skipped"). */
export async function skippedSet(store: SkillsStore): Promise<Set<string>> {
  return new Set(skippedNames(await readSkips(store)));
}

// One writer at a time per hub process (read-modify-write of one file). On
// globalThis because Next can load this module more than once.
const g = globalThis as { __AGENTBOX_SKILL_SKIPS_CHAIN?: Promise<unknown> };

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__AGENTBOX_SKILL_SKIPS_CHAIN ?? Promise.resolve();
  const run = prev.then(fn, fn);
  g.__AGENTBOX_SKILL_SKIPS_CHAIN = run.catch(() => undefined);
  return run;
}

/**
 * Skip or unskip one name; returns the list after the write and whether it
 * changed. The name need not be in the library: a skill only on a PC can be
 * skipped before it was ever imported.
 */
export function setSkillSkipped(
  store: SkillsStore,
  name: string,
  skip: boolean,
  now: Date = new Date(),
): Promise<{ changed: boolean; skipped: SkippedSkill[] }> {
  if (!isSkippableName(name)) {
    return Promise.reject(new SkillsError('invalid_request', `invalid skill name '${name}'`));
  }
  return serialized(async () => {
    const doc = await readSkips(store, { strict: true });
    const was = Object.hasOwn(doc.skipped, name);
    if (was === skip) return { changed: false, skipped: rows(doc) };
    const next = applySkip(doc, name, skip, now);
    await store.put(SKILL_SKIPS_PATH, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
    return { changed: true, skipped: rows(next) };
  });
}

/** The message every refused move of a skipped skill carries. */
export function skippedMessage(names: readonly string[]): string {
  const list = names.map((n) => `'${n}'`).join(', ');
  return names.length === 1
    ? `skill ${list} is skipped (never synced); tick its Sync box on Settings > Skills or run \`agentbox skills unskip ${names[0]!}\` first`
    : `skills ${list} are skipped (never synced); tick their Sync boxes on Settings > Skills or run \`agentbox skills unskip <name>\` first`;
}

/** Throw a 409 `conflict` when any of `names` is skipped. */
export async function assertNotSkipped(
  store: SkillsStore,
  names: readonly string[],
): Promise<void> {
  const skipped = await skippedSet(store);
  const hit = names.filter((n) => skipped.has(n));
  if (hit.length > 0) throw new SkillsError('conflict', skippedMessage(hit));
}
