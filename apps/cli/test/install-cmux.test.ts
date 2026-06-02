import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cmuxDockPath, upsertAgentboxControl } from '../src/commands/install-cmux.js';

describe('cmuxDockPath', () => {
  it('defaults to ~/.config/cmux/dock.json when XDG_CONFIG_HOME is unset', () => {
    expect(cmuxDockPath({})).toBe(join(homedir(), '.config', 'cmux', 'dock.json'));
  });

  it('honors XDG_CONFIG_HOME', () => {
    expect(cmuxDockPath({ XDG_CONFIG_HOME: '/custom/cfg' })).toBe('/custom/cfg/cmux/dock.json');
  });

  it('ignores an empty XDG_CONFIG_HOME', () => {
    expect(cmuxDockPath({ XDG_CONFIG_HOME: '' })).toBe(
      join(homedir(), '.config', 'cmux', 'dock.json'),
    );
  });
});

describe('upsertAgentboxControl', () => {
  const opts = { command: 'agentbox list --watch', title: 'AgentBox', height: 320 };

  it('appends the agentbox control to an empty doc', () => {
    const out = upsertAgentboxControl({ controls: [] }, opts);
    expect(out.controls).toEqual([
      { id: 'agentbox', title: 'AgentBox', command: 'agentbox list --watch', height: 320 },
    ]);
  });

  it('preserves sibling controls and appends agentbox', () => {
    const doc = { controls: [{ id: 'git', title: 'Git', command: 'lazygit', height: 300 }] };
    const out = upsertAgentboxControl(doc, opts);
    expect(out.controls.map((c) => c.id)).toEqual(['git', 'agentbox']);
    expect(out.controls[0]).toEqual({ id: 'git', title: 'Git', command: 'lazygit', height: 300 });
  });

  it('updates the existing agentbox control in place (keeps position and unknown keys)', () => {
    const doc = {
      controls: [
        { id: 'agentbox', title: 'old', command: 'agentbox list --watch', height: 200, cwd: '.' },
        { id: 'git', command: 'lazygit' },
      ],
    };
    const out = upsertAgentboxControl(doc, {
      command: 'agentbox list -g --watch',
      title: 'AgentBox',
      height: 320,
    });
    expect(out.controls.map((c) => c.id)).toEqual(['agentbox', 'git']);
    expect(out.controls[0]).toEqual({
      id: 'agentbox',
      title: 'AgentBox',
      command: 'agentbox list -g --watch',
      height: 320,
      cwd: '.', // unknown key preserved
    });
  });

  it('preserves unknown top-level keys on the doc', () => {
    const doc = { controls: [], version: 1 } as { controls: never[]; version: number };
    const out = upsertAgentboxControl(doc, opts);
    expect((out as { version?: number }).version).toBe(1);
  });

  it('tolerates a doc whose controls is missing', () => {
    const out = upsertAgentboxControl({} as { controls: never[] }, opts);
    expect(out.controls).toHaveLength(1);
    expect(out.controls[0]?.id).toBe('agentbox');
  });
});
