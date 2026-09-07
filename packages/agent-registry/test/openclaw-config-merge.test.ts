import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCLAW_CONFIG_MERGE_PROGRAM } from '../src/specs/openclaw.js';

/**
 * The merge AgentBox applies to openclaw's config, exercised by RUNNING it.
 *
 * The program only ever executes in a box, so a test that asserted on its source
 * text would pin the wrong thing. node is the same interpreter there.
 */
const SKILL_DIR = '/opt/agentbox/skills';
const CTX_PATH = '.agentbox/AGENTS.md';

interface Merged {
  skills: { load: { extraDirs: string[] } };
  hooks: { internal: { enabled: boolean; entries: Record<string, Record<string, unknown>> } };
}

/**
 * Run it exactly as the box does: written to a FILE and invoked as `node <file>
 * …`. Not `node -e`, which shifts argv by one — a test that used `-e` passed
 * while the real box read its first argument as the wrong parameter.
 *
 * The three raw arguments are `openclaw config get` output verbatim, which is
 * what the task pipes in: JSON when the value is set, empty when it is not.
 */
function run(rawDirs: string, rawEntries = '', rawHooksEnabled = ''): Merged {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-merge-'));
  const prog = join(dir, 'merge.cjs');
  writeFileSync(prog, OPENCLAW_CONFIG_MERGE_PROGRAM, 'utf8');
  const out = execFileSync(
    process.execPath,
    [prog, SKILL_DIR, CTX_PATH, rawDirs, rawEntries, rawHooksEnabled],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as Merged;
}

const entryOf = (r: Merged) => r.hooks.internal.entries['bootstrap-extra-files']!;

describe('the openclaw config merge', () => {
  it('asserts both keys on a box where neither is set', () => {
    const r = run('');
    expect(r.skills.load.extraDirs).toEqual([SKILL_DIR]);
    expect(entryOf(r).paths).toEqual([CTX_PATH]);
    expect(entryOf(r).enabled).toBe(true);
  });

  it("KEEPS the user's own entries in both arrays", () => {
    // The regression this program exists for. `openclaw config patch` replaces
    // an array wholesale, and `openclaw-render` re-sends only the overlay keys
    // that CHANGED — so a stable user value would survive the first boot and be
    // silently reverted on the second.
    const r = run(
      JSON.stringify(['/home/vscode/my-skills']),
      JSON.stringify({ 'bootstrap-extra-files': { paths: ['NOTES.md'] } }),
    );
    expect(r.skills.load.extraDirs).toEqual(['/home/vscode/my-skills', SKILL_DIR]);
    expect(entryOf(r).paths).toEqual(['NOTES.md', CTX_PATH]);
  });

  it('reads the pretty-printed shape `config get` actually prints', () => {
    // Not a JSON formatting detail: the task pipes this output in verbatim.
    const r = run('[\n  "/home/vscode/my-skills"\n]\n');
    expect(r.skills.load.extraDirs).toEqual(['/home/vscode/my-skills', SKILL_DIR]);
  });

  it('is idempotent — a second boot adds nothing', () => {
    const once = run('');
    // The second boot is fed exactly what `config get` would print AFTER the
    // first: the whole entries map, not the inner hook object. Passing the inner
    // object here made the lookup miss and quietly re-tested the unset path,
    // where a duplicate `paths` entry could never show up.
    const twice = run(
      JSON.stringify(once.skills.load.extraDirs),
      JSON.stringify(once.hooks.internal.entries),
    );
    expect(twice.skills.load.extraDirs).toEqual([SKILL_DIR]);
    expect(entryOf(twice).paths).toEqual([CTX_PATH]);
  });

  it('leaves the rest of the hook entry alone', () => {
    const r = run(
      '',
      JSON.stringify({ 'bootstrap-extra-files': { paths: [], maxCharsPerFile: 1234 } }),
    );
    expect(entryOf(r).maxCharsPerFile).toBe(1234);
  });

  it('lets the user turn the box facts OFF and have it stick', () => {
    // Disabling the injection is a choice they are allowed to make. Re-enabling
    // it every boot would be the same class of bug as clobbering the array.
    expect(
      entryOf(run('', JSON.stringify({ 'bootstrap-extra-files': { enabled: false } }))).enabled,
    ).toBe(false);
    expect(run('', '', 'false').hooks.internal.enabled).toBe(false);
  });

  it('leaves a neighbouring hook entry untouched', () => {
    // `session-memory` is enabled on every box. Reading the whole `entries`
    // object and naming only our key keeps it out of the patch entirely.
    const r = run(
      '',
      JSON.stringify({ 'session-memory': { enabled: true }, 'bootstrap-extra-files': {} }),
    );
    expect(Object.keys(r.hooks.internal.entries)).toEqual(['bootstrap-extra-files']);
  });

  it('never crashes on output it cannot parse', () => {
    // `config get` prints a human sentence for a valid-but-unset path, and
    // nothing at all when it fails. Neither may take the task down; the caller's
    // `config validate` gate is what makes treating these as "unset" safe.
    for (const raw of ['', 'Config path is valid but unset: skills.load.extraDirs.', '{not json']) {
      expect(run(raw).skills.load.extraDirs).toEqual([SKILL_DIR]);
    }
  });
});
