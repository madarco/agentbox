import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import type { BoxRegistration } from '@agentbox/relay';
import { addBoxAgent, type BoxAgentDeps } from '../lib/backend/box-agents';

/**
 * `agentbox openclaw <existing box>` (sign-off of #429, B1): the hub that owns
 * the box records the agent and re-registers it with the box's OWN token. A
 * PC-local re-register wrote the PC record's token and the box then 401ed.
 */
function fakeDeps(over: { box?: BoxRecord | null; reg?: BoxRegistration } = {}) {
  const registered: BoxRegistration[] = [];
  const recorded: string[] = [];
  const deps: BoxAgentDeps = {
    findBox: () => Promise.resolve(over.box ?? null),
    recordAgent: (_id, agent) => {
      recorded.push(agent);
      return Promise.resolve(over.box ? { ...over.box, agents: [agent] } : undefined);
    },
    getRegistration: () => Promise.resolve(over.reg),
    register: (reg) => {
      registered.push(reg);
      return Promise.resolve();
    },
    agentId: (name) => (name === 'openclaw' || name === 'claude' ? name : undefined),
  };
  return { deps, registered, recorded };
}

const box = { id: 'b1', name: 'nil', workspacePath: '/w', createdAt: '' } as BoxRecord;
const reg = { boxId: 'b1', token: 'hub-token', name: 'nil' } as BoxRegistration;

describe('addBoxAgent', () => {
  it("re-registers with the registration's own token and names the agent", async () => {
    const { deps, registered, recorded } = fakeDeps({ box, reg });
    const res = await addBoxAgent(deps, 'nil', 'openclaw');
    expect(res).toEqual({ kind: 'ok', boxId: 'b1', agents: ['openclaw'] });
    expect(recorded).toEqual(['openclaw']);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ boxId: 'b1', token: 'hub-token', agent: 'openclaw' });
  });

  it('works for a box the hub knows only by registration (registered from a PC)', async () => {
    const { deps, registered } = fakeDeps({ reg });
    expect((await addBoxAgent(deps, 'b1', 'openclaw')).kind).toBe('ok');
    expect(registered[0]?.agent).toBe('openclaw');
  });

  it('a claude box gaining openclaw registers both, claude still primary', async () => {
    const { deps, registered } = fakeDeps({ box, reg: { ...reg, agent: 'claude' } });
    await addBoxAgent(deps, 'b1', 'openclaw');
    expect(registered[0]).toMatchObject({ agent: 'claude', agents: ['claude', 'openclaw'] });
  });

  it('does not re-register when the registration already names the agent', async () => {
    const { deps, registered } = fakeDeps({ box, reg: { ...reg, agent: 'openclaw' } });
    await addBoxAgent(deps, 'b1', 'openclaw');
    expect(registered).toHaveLength(0);
  });

  it('refuses an unknown agent and an unknown box', async () => {
    expect((await addBoxAgent(fakeDeps({ box, reg }).deps, 'b1', 'nope')).kind).toBe('invalid');
    expect((await addBoxAgent(fakeDeps({ box, reg }).deps, 'b1', 'none')).kind).toBe('invalid');
    expect((await addBoxAgent(fakeDeps().deps, 'ghost', 'openclaw')).kind).toBe('not_found');
  });
});
