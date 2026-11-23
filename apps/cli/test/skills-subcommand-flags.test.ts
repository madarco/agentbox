import { describe, expect, it } from 'vitest';
import { skillsCommand } from '../src/commands/skills.js';

describe('agentbox skills subcommand flags', () => {
  it('hands --yes and --allow-findings to the subcommand, not the parent', () => {
    const update = skillsCommand.commands.find((c) => c.name() === 'update')!;
    const refresh = skillsCommand.commands.find((c) => c.name() === 'refresh')!;
    let seen: Record<string, unknown> = {};
    update.action((_names: string[], opts: Record<string, unknown>) => {
      seen = opts;
    });
    skillsCommand.parse(['update', 'x', '--yes'], { from: 'user' });
    expect(seen.yes).toBe(true);
    refresh.action((_names: string[], opts: Record<string, unknown>) => {
      seen = opts;
    });
    skillsCommand.parse(['refresh', '--allow-findings'], { from: 'user' });
    expect(seen.allowFindings).toBe(true);
  });
});
