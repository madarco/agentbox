import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxSkillDirs,
  describeBoxSkillOutcomes,
  PROBE_SCRIPT,
  probeRefusal,
  stagedSkillDir,
} from '../src/lib/skills/box-propose.js';

describe('box skill proposals', () => {
  it("maps each agent's skill dirs to box paths its config dir holds", () => {
    expect(boxSkillDirs('claude')).toEqual(['/home/vscode/.claude/skills']);
    expect(boxSkillDirs('codex')).toEqual(['/home/vscode/.codex/skills']);
    expect(boxSkillDirs('pi')).toEqual(['/home/vscode/.pi/agent/skills']);
    expect(boxSkillDirs('openclaw')).toEqual(['/home/vscode/.openclaw/skills']);
    // opencode's config dir is relocated under its data dir in a box.
    expect(boxSkillDirs('opencode')).toEqual(['/home/vscode/.local/share/opencode/config/skills']);
  });

  it('summarizes outcomes, with one approval hint', () => {
    const lines = describeBoxSkillOutcomes([
      { name: 'a', status: 'pending', isNew: true, findings: 0 },
      { name: 'b', status: 'pending', isNew: false, findings: 2 },
      { name: 'c', status: 'unchanged', isNew: false, findings: 0 },
      { name: 'd', status: 'skipped', reason: 'SKILL.md has no frontmatter' },
    ]);
    expect(lines).toEqual([
      '  a: proposed as a new library skill',
      '  b: proposed as a new version (secret scan: 2 finding(s))',
      '  c: the library already has this version',
      '  d: not proposed (SKILL.md has no frontmatter)',
      '2 skill proposal(s) wait for approval in the hub (web Approvals, the tray, or a box footer); approved skills reach new boxes.',
    ]);
  });

  it('refuses a box-supplied name that is not one safe skill segment', () => {
    expect(stagedSkillDir('/tmp/stage', 1, 'ok-skill')).toBe('/tmp/stage/1/ok-skill');
    for (const bad of ['../../../home/u/.ssh', '..', 'a/b', 'UPPER', '', '-x']) {
      expect(() => stagedSkillDir('/tmp/stage', 1, bad)).toThrow(/not a valid skill name/);
    }
  });
});

// The in-box probe, run for real with this machine's sh/find/awk (a box runs the
// same GNU tools). No HOME is touched: everything is under a fresh temp dir.
describe('box skill probe (before anything leaves the box)', () => {
  const probe = (dir: string, max = 8 * 1024 * 1024): string | null =>
    probeRefusal(execFileSync('sh', ['-c', PROBE_SCRIPT(dir)], { encoding: 'utf8' }), dir, max);
  const skillDir = (): string => {
    const d = join(mkdtempSync(join(tmpdir(), 'agentbox-probe-')), 'my-skill');
    mkdirSync(join(d, 'scripts'), { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\n');
    writeFileSync(join(d, 'scripts', 'run.sh'), 'echo hi\n');
    return d;
  };

  it('passes a skill of plain files and folders', () => {
    expect(probe(skillDir())).toBeNull();
  });

  it('leaves links to the host checks (readLocalSkill / readSkillTree)', () => {
    const d = skillDir();
    rmSync(join(d, 'SKILL.md'));
    symlinkSync('/dev/zero', join(d, 'SKILL.md'));
    // The probe lets a link through; a SKILL.md linked to /dev/zero is refused
    // host-side by readLocalSkill (packages/sandbox-core skills-concern test).
    expect(probe(d)).toBeNull();
  });

  it("doesn't count .git toward the cap, as the library doesn't", () => {
    const d = skillDir();
    mkdirSync(join(d, '.git'));
    writeFileSync(join(d, '.git', 'pack'), Buffer.alloc(4096));
    expect(probe(d, 1024)).toBeNull();
  });

  it('refuses when find cannot run in the box (fails closed)', () => {
    const d = skillDir();
    const r = spawnSync('sh', ['-c', `PATH=/nonexistent; ${PROBE_SCRIPT(d)}`], {
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(probeRefusal(r.stdout, d, 8 * 1024 * 1024)).toMatch(/could not be checked/);
  });

  it('refuses a FIFO', () => {
    const d = skillDir();
    execFileSync('mkfifo', [join(d, 'pipe')]);
    expect(probe(d)).toMatch(/holds pipe, which is not a plain file, folder or link/);
  });

  it('refuses a skill over the cap before pulling it', () => {
    const d = skillDir();
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(2048));
    expect(probe(d, 1024)).toMatch(/over the 1024-byte cap for a proposed skill/);
  });

  it('refuses when the probe printed nothing it can read', () => {
    expect(probeRefusal('', '/x', 10)).toMatch(/could not be checked/);
  });
});
