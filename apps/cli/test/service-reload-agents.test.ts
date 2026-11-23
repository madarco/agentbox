import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { reloadAgentUnits } from '../src/agents/command/service-action.js';

/** After an agent is added to a running box, its ctl must re-ask `agents.list`. */
describe('reloadAgentUnits', () => {
  const box = { id: 'b', name: 'b', workspacePath: '/w', createdAt: '' } as BoxRecord;
  const run = (answers: { exitCode: number; stderr: string }[]) => {
    const calls: string[][] = [];
    const provider = {
      exec: (_b: BoxRecord, argv: string[]) => {
        calls.push(argv);
        const a = answers.shift() ?? { exitCode: 0, stderr: '' };
        return Promise.resolve({ ...a, stdout: '' });
      },
    };
    return { provider, calls };
  };

  it('asks the running ctl to refresh its agents', async () => {
    const { provider, calls } = run([{ exitCode: 0, stderr: '' }]);
    expect(await reloadAgentUnits(provider, box)).toBe('reloaded');
    expect(calls).toEqual([['agentbox-ctl', 'reload', '--agents']]);
  });

  it('asks for a restart on a ctl that predates the flag (a plain reload adds nothing)', async () => {
    const { provider, calls } = run([{ exitCode: 1, stderr: "error: unknown option '--agents'" }]);
    expect(await reloadAgentUnits(provider, box)).toBe('needs-restart');
    expect(calls).toHaveLength(1);
  });

  it('reports a failure that is not the missing flag', async () => {
    const { provider } = run([{ exitCode: 1, stderr: 'agents.list unavailable' }]);
    expect(await reloadAgentUnits(provider, box)).toBe('failed');
  });
});
