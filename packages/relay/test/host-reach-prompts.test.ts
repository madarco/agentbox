import { describe, expect, it } from 'vitest';
import { mirrorHostReachPrompts, type HostReachPromptClient } from '../src/host-reach-prompts.js';
import { askPrompt, PendingPrompts, PromptSubscribers } from '../src/prompts.js';

/**
 * A serving PC's confirm is mirrored into the hub's approvals (Phase 4): the
 * owner can answer it from the web UI or the tray, and an answer on either side
 * settles the other.
 */

function fakeHub(answer?: 'y' | 'n') {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const answered = new Promise<void>((r) => (release = r));
  const client: HostReachPromptClient = {
    raise: (actionId, prompt) => {
      calls.push(`raise ${actionId} ${prompt.message}`);
      return Promise.resolve('hub-1');
    },
    status: async () => {
      if (answer) {
        await answered;
        return { status: 'answered', answer };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { status: 'pending' };
    },
    cancel: (id) => {
      calls.push(`cancel ${id}`);
      return Promise.resolve();
    },
  };
  return { client, calls, release: () => release?.() };
}

const ask = {
  kind: 'confirm' as const,
  message: 'Allow cp (host -> box) on b1?',
  defaultAnswer: 'n' as const,
};

describe('mirrorHostReachPrompts', () => {
  it("an answer in the hub approvals settles the PC's prompt", async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const hub = fakeHub('y');
    const stop = mirrorHostReachPrompts({
      prompts,
      subscribers: subs,
      boxId: 'b1',
      actionId: 'a1',
      client: hub.client,
    });
    const verdict = askPrompt(prompts, subs, 'b1', ask);
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.calls).toEqual(['raise a1 Allow cp (host -> box) on b1?']);
    hub.release();
    await expect(verdict).resolves.toMatchObject({ answer: 'y' });
    expect(prompts.size()).toBe(0);
    stop();
  });

  it('an answer on the PC takes the prompt down from the hub', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const hub = fakeHub();
    const stop = mirrorHostReachPrompts({
      prompts,
      subscribers: subs,
      boxId: 'b1',
      actionId: 'a1',
      client: hub.client,
    });
    const verdict = askPrompt(prompts, subs, 'b1', ask);
    await new Promise((r) => setTimeout(r, 5));
    const [pending] = prompts.all();
    prompts.resolve(pending!.id, 'n');
    await expect(verdict).resolves.toMatchObject({ answer: 'n' });
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.calls).toContain('cancel hub-1');
    stop();
  });

  it('keeps the prompt local against a hub without the route', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const client: HostReachPromptClient = {
      raise: () => Promise.resolve(null),
      status: () => Promise.reject(new Error('not called')),
      cancel: () => Promise.reject(new Error('not called')),
    };
    const stop = mirrorHostReachPrompts({
      prompts,
      subscribers: subs,
      boxId: 'b1',
      actionId: 'a1',
      client,
    });
    const verdict = askPrompt(prompts, subs, 'b1', ask);
    await new Promise((r) => setTimeout(r, 5));
    prompts.resolve(prompts.all()[0]!.id, 'y');
    await expect(verdict).resolves.toMatchObject({ answer: 'y' });
    stop();
  });

  it('stops mirroring once the action is done', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const hub = fakeHub();
    mirrorHostReachPrompts({
      prompts,
      subscribers: subs,
      boxId: 'b1',
      actionId: 'a1',
      client: hub.client,
    })();
    void askPrompt(prompts, subs, 'b1', ask);
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.calls).toEqual([]);
  });

  it("mirrors only the action's own confirm, not another prompt the box raises meanwhile (7)", async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const hub = fakeHub();
    const stop = mirrorHostReachPrompts({
      prompts,
      subscribers: subs,
      boxId: 'b1',
      actionId: 'a1',
      client: hub.client,
      match: (ev) => ev.context?.command === 'cp.fromHost',
    });
    void askPrompt(prompts, subs, 'b1', { ...ask, context: { command: 'git push' } });
    void askPrompt(prompts, subs, 'b1', { ...ask, context: { command: 'cp.fromHost' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.calls).toEqual(['raise a1 Allow cp (host -> box) on b1?']);
    stop();
  });
});
