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
 * Run it exactly as the box does: written to a FILE and invoked as `node
 * <file> …`. Not `node -e`, which shifts argv by one — a test that used `-e`
 * passed while the real box read the config path as the skills dir.
 */
function run(cfgPath: string): Merged {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-merge-prog-'));
  const prog = join(dir, 'merge.cjs');
  writeFileSync(prog, OPENCLAW_CONFIG_MERGE_PROGRAM, 'utf8');
  const out = execFileSync(process.execPath, [prog, cfgPath, SKILL_DIR, CTX_PATH], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as Merged;
}

function merge(config: unknown): Merged {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-merge-'));
  const cfg = join(dir, 'openclaw.json');
  writeFileSync(cfg, JSON.stringify(config), 'utf8');
  return run(cfg);
}

const entryOf = (r: Merged) => r.hooks.internal.entries['bootstrap-extra-files']!;

describe('the openclaw config merge', () => {
  it('asserts both keys on a config that has neither', () => {
    const r = merge({});
    expect(r.skills.load.extraDirs).toEqual([SKILL_DIR]);
    expect(entryOf(r).paths).toEqual([CTX_PATH]);
    expect(entryOf(r).enabled).toBe(true);
  });

  it("KEEPS the user's own entries in both arrays", () => {
    // The regression this program exists for. `openclaw config patch` replaces
    // an array wholesale, and `openclaw-render` re-sends only the overlay keys
    // that CHANGED — so a stable user value would survive the first boot and be
    // silently reverted on the second.
    const r = merge({
      skills: { load: { extraDirs: ['/home/vscode/my-skills'] } },
      hooks: {
        internal: { entries: { 'bootstrap-extra-files': { paths: ['NOTES.md'] } } },
      },
    });
    expect(r.skills.load.extraDirs).toEqual(['/home/vscode/my-skills', SKILL_DIR]);
    expect(entryOf(r).paths).toEqual(['NOTES.md', CTX_PATH]);
  });

  it('is idempotent — a second boot adds nothing', () => {
    const twice = merge(merge({}));
    expect(twice.skills.load.extraDirs).toEqual([SKILL_DIR]);
    expect(entryOf(twice).paths).toEqual([CTX_PATH]);
  });

  it('leaves the rest of the hook entry alone', () => {
    const r = merge({
      hooks: {
        internal: {
          entries: { 'bootstrap-extra-files': { paths: [], maxCharsPerFile: 1234 } },
        },
      },
    });
    expect(entryOf(r).maxCharsPerFile).toBe(1234);
  });

  it('lets the user turn the box facts OFF and have it stick', () => {
    // Disabling the injection is a choice they are allowed to make. Re-enabling
    // it every boot would be the same class of bug as clobbering the array.
    const offEntry = merge({
      hooks: { internal: { entries: { 'bootstrap-extra-files': { enabled: false } } } },
    });
    expect(entryOf(offEntry).enabled).toBe(false);
    expect(merge({ hooks: { internal: { enabled: false } } }).hooks.internal.enabled).toBe(false);
  });

  it('survives a config file that is missing or corrupt', () => {
    // Best-effort: the task must not fail a box over this.
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-merge-'));
    const bad = join(dir, 'openclaw.json');
    writeFileSync(bad, '{not json', 'utf8');
    for (const path of [bad, join(dir, 'absent.json')]) {
      expect(run(path).skills.load.extraDirs).toEqual([SKILL_DIR]);
    }
  });
});
