import { describe, expect, it, vi } from 'vitest';
import { PendingPrompts, PromptSubscribers, raisePrompt } from '../src/prompts.js';

/** Minimal `ServerResponse`-shaped sink (mirrors prompts.test.ts). */
function makeSink(): { writes: string[]; res: { write(s: string): true } } {
  const writes: string[] = [];
  return {
    writes,
    res: {
      write(s: string): true {
        writes.push(s);
        return true;
      },
    },
  };
}

function parseEvents(writes: string[]): { event: string; data: Record<string, unknown> }[] {
  return writes.map((w) => {
    const event = /event: (\S+)/.exec(w)?.[1] ?? '';
    const data = JSON.parse(/data: (.*)\n\n$/s.exec(w)?.[1] ?? '{}') as Record<string, unknown>;
    return { event, data };
  });
}

describe('raisePrompt (daemon-created, non-blocking)', () => {
  it('parks the prompt, returns its id, and broadcasts prompt-ask', () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-1', sink.res as never);

    const { id } = raisePrompt(prompts, subs, 'box-1', {
      kind: 'open-link',
      message: 'AWS session expired — sign in',
      url: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      hostOpen: false,
      defaultAnswer: 'n',
    });

    // Non-blocking: the prompt is pending immediately, no await required.
    expect(prompts.size()).toBe(1);
    expect(prompts.boxFor(id)).toBe('box-1');

    const [ev] = parseEvents(sink.writes);
    expect(ev?.event).toBe('prompt-ask');
    expect(ev?.data).toMatchObject({
      id,
      kind: 'open-link',
      url: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      hostOpen: false,
    });
  });

  it('surfaces the answer (incl. openedByClient) on the resolution promise', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const { id, resolution } = raisePrompt(prompts, subs, 'box-1', {
      kind: 'open-link',
      message: 'sign in',
      url: 'https://example.com',
    });
    prompts.resolve(id, 'y', undefined, true);
    await expect(resolution).resolves.toMatchObject({ answer: 'y', openedByClient: true });
  });

  it('NEVER auto-approves: a raised prompt reports something only a human can fix', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    // A box with the blanket auto-approve opt-in. askPrompt would return 'y'
    // without surfacing anything — which for "your session expired" would be a
    // lie that silently drops the re-auth request on the floor.
    const audit = vi.fn();
    prompts.setAutoApprovePolicy({ shouldAutoApprove: () => true, audit });

    const { id } = raisePrompt(prompts, subs, 'box-1', {
      kind: 'open-link',
      message: 'sign in',
      url: 'https://example.com',
    });
    expect(prompts.size()).toBe(1);
    expect(prompts.boxFor(id)).toBe('box-1');
    expect(audit).not.toHaveBeenCalled();
  });

  it('TTL reaps an unanswered prompt (a missed re-auth must not pin the approvals list)', async () => {
    vi.useFakeTimers();
    try {
      const prompts = new PendingPrompts();
      const subs = new PromptSubscribers();
      const sink = makeSink();
      subs.add('box-1', sink.res as never);

      const { resolution } = raisePrompt(
        prompts,
        subs,
        'box-1',
        { kind: 'open-link', message: 'sign in', url: 'https://example.com', defaultAnswer: 'n' },
        { ttlMs: 1000 },
      );
      expect(prompts.size()).toBe(1);
      await vi.advanceTimersByTimeAsync(1001);

      expect(prompts.size()).toBe(0);
      await expect(resolution).resolves.toMatchObject({ answer: 'n', cancelled: true });
      expect(parseEvents(sink.writes).map((e) => e.event)).toEqual(['prompt-ask', 'prompt-resolved']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the creator can clear its own prompt when the underlying flow finishes', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const { id, resolution } = raisePrompt(prompts, subs, 'box-1', {
      kind: 'open-link',
      message: 'sign in',
      url: 'https://example.com',
    });
    // The device login completed on its own — drop the card.
    expect(prompts.resolve(id, 'y', true)).toBe(true);
    expect(prompts.size()).toBe(0);
    await expect(resolution).resolves.toMatchObject({ answer: 'y', cancelled: true });
  });
});

