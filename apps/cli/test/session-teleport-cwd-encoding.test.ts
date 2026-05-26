import { describe, expect, it } from 'vitest';
import {
  BOX_WORKSPACE_ENCODED,
  encodeClaudeProjectsDir,
} from '../src/session-teleport/cwd-encoding.js';

describe('encodeClaudeProjectsDir', () => {
  it('encodes a normal Projects path', () => {
    expect(encodeClaudeProjectsDir('/Users/marco/Projects/AgentBox/agentbox')).toBe(
      '-Users-marco-Projects-AgentBox-agentbox',
    );
  });

  it('encodes dot directories with a double dash', () => {
    expect(encodeClaudeProjectsDir('/Users/marco/.agents/skills')).toBe(
      '-Users-marco--agents-skills',
    );
    expect(encodeClaudeProjectsDir('/Users/marco/.claude/plugins/marketplaces')).toBe(
      '-Users-marco--claude-plugins-marketplaces',
    );
  });

  it('preserves alphanumerics and replaces dashes too', () => {
    expect(
      encodeClaudeProjectsDir('/Users/marco/Projects/AgentBox/agentbox/examples/test-workspace'),
    ).toBe('-Users-marco-Projects-AgentBox-agentbox-examples-test-workspace');
  });

  it('encodes /workspace to -workspace', () => {
    expect(encodeClaudeProjectsDir('/workspace')).toBe('-workspace');
    expect(BOX_WORKSPACE_ENCODED).toBe('-workspace');
  });
});
