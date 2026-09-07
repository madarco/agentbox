import { describe, expect, it } from 'vitest';
import { AGENT_SPECS } from '../src/index.js';

/**
 * The task that tells an OpenClaw box where it is running.
 *
 * Every shape below was MEASURED against openclaw 2026.9.2 on a live box, not
 * inferred — each assertion pins something that silently produced nothing when
 * it was wrong.
 */
const spec = AGENT_SPECS.find((s) => s.id === 'openclaw')!;
const task = spec.service!.tasks!.find((t) => t.name === 'openclaw-agentbox-env')!;
const script = task.command as string;

describe('openclaw-agentbox-env', () => {
  it('runs after onboard and before the render', () => {
    // onboard writes the config file this task patches; the render applies the
    // USER's overlay afterwards, so the user has the last word on a shared key.
    expect(task.needs).toEqual(['openclaw-onboard']);
    const render = spec.service!.tasks!.find((t) => t.name === 'openclaw-render')!;
    expect(render.needs).toEqual(['openclaw-agentbox-env']);
  });

  it('re-runs on every boot rather than once', () => {
    // The prompt file lives in the workspace, so `agentbox clone` carries the
    // SOURCE box's facts into the new box. A `runOnce` marker would let those
    // stale facts stand.
    expect(task.runOnce).toBeUndefined();
  });

  it('installs the skill as a directory, not a flat .md', () => {
    // openclaw discovers skills as `<name>/SKILL.md`; a flat `agentbox-setup.md`
    // in the same root was NOT found.
    expect(script).toContain('/opt/agentbox/skills/agentbox-setup');
    expect(script).toContain('SKILL.md');
  });

  it('copies the skill rather than symlinking it', () => {
    // openclaw refuses a skill symlink whose real target is outside the source
    // root unless it is in `skills.load.allowSymlinkTargets`. A symlink to
    // /usr/local/share/agentbox was silently skipped.
    expect(script).not.toMatch(/ln -s/);
    expect(script).toContain('install -m 0644');
  });

  it('does not try to hide itself by editing the box repo', () => {
    // Keeping the generated file out of the user's project is the PULL layer's
    // job (`GIT_MODE_EXCLUDE_DIRS`), not this script's. Writing an exclude here
    // cannot work and is not harmless: in a docker box `/workspace/.git` is a
    // linked-worktree FILE whose per-worktree `info/exclude` git ignores, and
    // the common dir it does read is the user's bind-mounted host repo.
    expect(script).not.toContain('info/exclude');
    expect(script).not.toMatch(/\.git\b/);
  });

  it('writes the prompt file atomically, behind a sentinel', () => {
    // The sentinel is what makes a re-run idempotent instead of folding the
    // previous generation into the next one.
    expect(script).toMatch(/agentbox:box-facts/);
    expect(script).toMatch(/AGENTS\.md\.agentbox\.tmp/);
    expect(script).toMatch(/mv "\$TMP"/);
  });

  it('asserts both config keys in ONE validated merge', () => {
    // `config patch --stdin` is openclaw's own validated recursive merge — the
    // exact payload was dry-run against a live gateway.
    expect(script).toContain('openclaw config patch --stdin');
    const json = /'(\{"skills".*?\})'/.exec(script)?.[1];
    expect(json, 'the owned-config payload is not in the script').toBeDefined();
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect(parsed).toEqual({
      skills: { load: { extraDirs: ['/opt/agentbox/skills'] } },
      hooks: {
        internal: {
          enabled: true,
          entries: { 'bootstrap-extra-files': { enabled: true, paths: ['.agentbox/AGENTS.md'] } },
        },
      },
    });
  });

  it('names a bootstrap basename openclaw actually accepts', () => {
    // The hook loads only the six canonical names; `.agentbox/AGENTBOX.md`
    // would be rejected as `invalid-bootstrap-filename`.
    const canonical = [
      'AGENTS.md',
      'SOUL.md',
      'IDENTITY.md',
      'USER.md',
      'BOOTSTRAP.md',
      'MEMORY.md',
    ];
    const json = /'(\{"skills".*?\})'/.exec(script)![1]!;
    const paths = (
      JSON.parse(json) as { hooks: { internal: { entries: Record<string, { paths: string[] }> } } }
    ).hooks.internal.entries['bootstrap-extra-files']!.paths;
    for (const p of paths) expect(canonical).toContain(p.split('/').pop());
  });

  it('never fails the box: every step is guarded', () => {
    // A base image too old to carry the baked files must still boot.
    expect(script).toContain('set -u');
    expect(script).not.toContain('set -e');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });
});
