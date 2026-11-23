import { describe, expect, it } from 'vitest';
import { boxSkillDirs, describeBoxSkillOutcomes } from '../src/lib/skills/box-propose.js';

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
});
