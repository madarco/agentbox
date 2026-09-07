import { describe, expect, it } from 'vitest';
import { AGENT_SPECS } from '../src/index.js';
import { OPENCLAW_CONFIG_MERGE_PROGRAM } from '../src/specs/openclaw.js';

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

  it("applies both keys through openclaw's own validated merge", () => {
    // `config patch --stdin` is openclaw's validated recursive merge. What it
    // is fed is COMPUTED in the box (see `openclaw-config-merge.test.ts` for the
    // merge itself) because patch replaces an array wholesale — a static payload
    // would silently drop a user's own extraDirs on the second boot.
    expect(script).toContain('openclaw config patch --stdin');
    expect(script).toContain(OPENCLAW_CONFIG_MERGE_PROGRAM.trim());
    expect(script).toContain('/opt/agentbox/skills .agentbox/AGENTS.md');
  });

  it("reads the current values through openclaw's own reader, not the file", () => {
    // The config is JSON5 — openclaw reads one with a `//` comment in it and
    // `JSON.parse` throws on the same file (both verified in a box) — so parsing
    // it here would see nothing and clobber the arrays the merge exists to keep.
    expect(script).toContain('openclaw config get');
    expect(script).not.toContain('openclaw.json');
    expect(script).toMatch(/rm -f "\$PROG"/);
  });

  it('only touches the config when openclaw says the config is good', () => {
    // `config get` prints nothing and exits 1 both for an unset value and for
    // one it cannot read, so without this gate a broken config looks exactly
    // like a fresh box — and would be overwritten with our entry alone.
    expect(script).toContain('if openclaw config validate');
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
    const ctxArg = /\/opt\/agentbox\/skills (\S+)/.exec(script)?.[1];
    expect(ctxArg, 'the context path is not passed to the merge').toBeDefined();
    expect(canonical).toContain(ctxArg!.split('/').pop());
  });

  it('never fails the box: every step is guarded', () => {
    // A base image too old to carry the baked files must still boot.
    expect(script).toContain('set -u');
    expect(script).not.toContain('set -e');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('the identity nudge', () => {
  it('installs the identity skill beside the setup one', () => {
    expect(script).toContain('/opt/agentbox/skills/agentbox-identity');
    expect(script).toContain('/usr/local/share/agentbox/identity-skill.md');
  });

  it('guards both skills on the baked file existing', () => {
    // A base image baked before a skill existed simply lacks the file. The task
    // must still exit 0 there — it is best-effort, and a box is not worth
    // failing over a missing prompt.
    for (const p of [
      '/usr/local/share/agentbox/setup-guide.md',
      '/usr/local/share/agentbox/identity-skill.md',
    ]) {
      expect(script).toContain(`if [ -f ${p} ]; then`);
    }
  });

  it('nudges ONLY while the workspace declares no identity rules', () => {
    // The yaml sentinel is the only state. No marker file, so nothing can go
    // stale: the nudge is regenerated every boot and stops appearing the moment
    // the bot writes the rule-set. Mutating either half of this condition brings
    // back a prompt that never leaves, or one that never arrives.
    expect(script).toMatch(
      /!\s*grep -qs 'agentbox:identity-rules' \/workspace\/agentbox\.yaml/,
    );
    expect(script).toContain('$IDENTITY_NUDGE');
  });

  it('names the skill the bot should follow, so the nudge is actionable', () => {
    expect(script).toContain('agentbox-identity');
    expect(script).toMatch(/identity is not portable/);
  });
});
