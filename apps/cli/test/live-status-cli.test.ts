// Live status, Phase 4: the working-on line under an `ls` row and the agent
// block `inspect` adds from the hub.
import { describe, expect, it } from 'vitest';
import type { HubApiBox } from '../src/control-plane/hub-api-client.js';
import { workingOnLines } from '../src/commands/list.js';
import { renderAgentLiveLines } from '../src/commands/inspect.js';

function box(p: Partial<HubApiBox>): HubApiBox {
  return {
    id: 'b',
    name: 'b',
    task: 'b',
    provider: 'docker',
    status: 'running',
    branch: '',
    state: 'running',
    ...p,
  } as HubApiBox;
}

const USAGE = {
  input: 1200,
  output: 3400,
  cacheRead: 1_000_000,
  cacheWrite: 20_000,
  contextTokens: 90_000,
  contextWindow: 200_000,
  updatedAt: '2026-11-25T00:00:00Z',
};

describe('ls working-on line', () => {
  it('shows only for a working agent of a running box', () => {
    const b = box({
      agentStatus: {
        claude: { state: 'working', activity: 'bash: npm test' },
        codex: { state: 'idle', activity: 'Done, all green.' },
        pi: { state: 'waiting', activity: 'edit server.js' },
      },
    });
    expect(workingOnLines(b, 120)).toEqual(['   > claude: bash: npm test']);
    expect(workingOnLines({ ...b, state: 'paused', status: 'paused' }, 120)).toEqual([]);
    expect(workingOnLines(box({ agentStatus: { claude: { state: 'working' } } }), 120)).toEqual([]);
  });
  it('fits the terminal width', () => {
    const b = box({ agentStatus: { claude: { state: 'working', activity: 'x'.repeat(200) } } });
    const [line] = workingOnLines(b, 40);
    expect(line).toHaveLength(39);
    expect(line?.endsWith('…')).toBe(true);
  });
});

describe('inspect agent block', () => {
  it('title, activity while working, tokens', () => {
    const lines = renderAgentLiveLines(
      box({
        agentStatus: {
          claude: {
            state: 'working',
            sessionTitle: 'Fix login',
            activity: 'bash: npm test',
            usage: USAGE,
          },
        },
      }),
    );
    expect(lines.join('\n')).toContain('title       Fix login');
    expect(lines.join('\n')).toContain('working on  bash: npm test');
    expect(lines.join('\n')).toContain('tokens      1M tok · 45% ctx');
    expect(lines.join('\n')).toContain('context 90k / 200k (45%)');
  });
  it('an idle agent shows no working-on line; no data shows nothing', () => {
    const idle = renderAgentLiveLines(
      box({
        agentStatus: { claude: { state: 'idle', sessionTitle: 'T', activity: 'Final reply' } },
      }),
    );
    expect(idle.join('\n')).not.toContain('working on');
    expect(renderAgentLiveLines(box({ agentStatus: { claude: { state: 'idle' } } }))).toEqual([]);
    expect(renderAgentLiveLines(null)).toEqual([]);
  });
});
