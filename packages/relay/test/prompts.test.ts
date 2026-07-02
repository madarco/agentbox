import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  askPrompt,
  isPromptAnswerBody,
  PendingPrompts,
  PromptSubscribers,
} from '../src/prompts.js';

/**
 * Minimal `ServerResponse`-shaped sink: captures every `write()` so tests
 * can assert the SSE payload without booting the HTTP server.
 */
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

describe('PendingPrompts', () => {
  it('add then resolve completes the awaited promise', async () => {
    const p = new PendingPrompts();
    const result = p.add('box-1', {
      id: 'abc',
      kind: 'confirm',
      message: 'go?',
    });
    expect(p.size()).toBe(1);
    const ok = p.resolve('abc', 'y');
    expect(ok).toBe(true);
    expect(p.size()).toBe(0);
    await expect(result).resolves.toEqual({ answer: 'y', cancelled: undefined });
  });

  it('resolve is idempotent (second call returns false)', () => {
    const p = new PendingPrompts();
    void p.add('box-1', { id: 'abc', kind: 'confirm', message: 'go?' });
    expect(p.resolve('abc', 'y')).toBe(true);
    expect(p.resolve('abc', 'y')).toBe(false);
  });

  it('forBox filters by box id', () => {
    const p = new PendingPrompts();
    void p.add('a', { id: 'a1', kind: 'confirm', message: 'a1' });
    void p.add('b', { id: 'b1', kind: 'confirm', message: 'b1' });
    void p.add('a', { id: 'a2', kind: 'confirm', message: 'a2' });
    expect(p.forBox('a').map((e) => e.id).sort()).toEqual(['a1', 'a2']);
    expect(p.forBox('b').map((e) => e.id)).toEqual(['b1']);
  });

  it('boxFor returns the owning box id or null', () => {
    const p = new PendingPrompts();
    void p.add('boxx', { id: 'q1', kind: 'confirm', message: 'q1' });
    expect(p.boxFor('q1')).toBe('boxx');
    expect(p.boxFor('missing')).toBeNull();
  });

  it('all() lists every pending prompt across boxes with its boxId + createdAt', () => {
    const p = new PendingPrompts();
    void p.add('a', { id: 'a1', kind: 'confirm', message: 'a1' });
    void p.add('b', { id: 'b1', kind: 'confirm', message: 'b1' });
    const all = p.all();
    expect(all.map((e) => e.id).sort()).toEqual(['a1', 'b1']);
    const a1 = all.find((e) => e.id === 'a1')!;
    expect(a1.boxId).toBe('a');
    expect(a1.ev.message).toBe('a1');
    expect(typeof a1.createdAt).toBe('string');
    // resolving drops it from the listing
    p.resolve('a1', 'y');
    expect(p.all().map((e) => e.id)).toEqual(['b1']);
  });

  it('setOnChange fires on add and on resolve', () => {
    const p = new PendingPrompts();
    let calls = 0;
    p.setOnChange(() => {
      calls += 1;
    });
    void p.add('a', { id: 'a1', kind: 'confirm', message: 'a1' });
    expect(calls).toBe(1);
    p.resolve('a1', 'y');
    expect(calls).toBe(2);
    // a no-op resolve (already gone) does not fire
    p.resolve('a1', 'y');
    expect(calls).toBe(2);
  });

  it('forwards `cancelled` to the awaiting promise', async () => {
    const p = new PendingPrompts();
    const result = p.add('box-1', { id: 'x', kind: 'confirm', message: 'q' });
    p.resolve('x', 'n', true);
    await expect(result).resolves.toEqual({ answer: 'n', cancelled: true });
  });
});

describe('PromptSubscribers', () => {
  it('broadcast writes the SSE-formatted payload to every subscriber', () => {
    const subs = new PromptSubscribers();
    const a = makeSink();
    const b = makeSink();
    subs.add('box-1', a.res as never);
    subs.add('box-1', b.res as never);
    subs.broadcast('box-1', 'prompt-ask', { id: 'q1', foo: 'bar' });
    expect(a.writes).toEqual(['event: prompt-ask\ndata: {"id":"q1","foo":"bar"}\n\n']);
    expect(b.writes).toEqual(a.writes);
  });

  it('only broadcasts to subscribers of the matching box', () => {
    const subs = new PromptSubscribers();
    const a = makeSink();
    const b = makeSink();
    subs.add('box-A', a.res as never);
    subs.add('box-B', b.res as never);
    subs.broadcast('box-A', 'prompt-ask', { id: 'q1' });
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(0);
  });

  it('remove deregisters the subscriber', () => {
    const subs = new PromptSubscribers();
    const a = makeSink();
    subs.add('box-A', a.res as never);
    subs.remove('box-A', a.res as never);
    subs.broadcast('box-A', 'prompt-ask', { id: 'q1' });
    expect(a.writes).toHaveLength(0);
  });

  it('swallows write errors on dead sockets', () => {
    const subs = new PromptSubscribers();
    const fake = new EventEmitter() as unknown as { write(s: string): true };
    fake.write = (): true => {
      throw new Error('EPIPE');
    };
    subs.add('box-A', fake as never);
    expect(() => subs.broadcast('box-A', 'prompt-ask', { id: 'q1' })).not.toThrow();
  });
});

describe('askPrompt', () => {
  it('generates an id, broadcasts, and resolves once the answer arrives', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-1', sink.res as never);

    const promise = askPrompt(prompts, subs, 'box-1', {
      kind: 'confirm',
      message: 'go?',
    });

    expect(sink.writes).toHaveLength(1);
    const written = sink.writes[0]!;
    // payload is in the data line — extract and parse to recover the id.
    const match = /data: (\{.*\})/.exec(written);
    expect(match).not.toBeNull();
    const ev = JSON.parse(match![1]!) as { id: string; kind: string; message: string };
    expect(ev.kind).toBe('confirm');
    expect(ev.message).toBe('go?');
    expect(ev.id).toMatch(/^[0-9a-f-]{36}$/);

    prompts.resolve(ev.id, 'y');
    await expect(promise).resolves.toEqual({ answer: 'y', cancelled: undefined });
  });

  it('auto-accepts when AGENTBOX_PROMPT=off (no broadcast)', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-1', sink.res as never);

    const prev = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    try {
      const result = await askPrompt(prompts, subs, 'box-1', {
        kind: 'confirm',
        message: 'go?',
      });
      expect(result).toEqual({ answer: 'y' });
      expect(sink.writes).toHaveLength(0);
      expect(prompts.size()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AGENTBOX_PROMPT;
      else process.env.AGENTBOX_PROMPT = prev;
    }
  });

  it('auto-approves (with audit) when the box opted into autoApproveHostActions', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-on', sink.res as never);

    const audited: Array<{ boxId: string; command?: string }> = [];
    prompts.setAutoApprovePolicy({
      shouldAutoApprove: (boxId) => boxId === 'box-on',
      audit: (boxId, params) => audited.push({ boxId, command: params.context?.command }),
    });

    // Opted-in box: resolves 'y' immediately, no broadcast, audit recorded.
    const onResult = await askPrompt(prompts, subs, 'box-on', {
      kind: 'confirm',
      message: 'go?',
      context: { command: 'git push' },
    });
    expect(onResult).toEqual({ answer: 'y' });
    expect(sink.writes).toHaveLength(0);
    expect(prompts.size()).toBe(0);
    expect(audited).toEqual([{ boxId: 'box-on', command: 'git push' }]);

    // A box without the flag still pends (must be answered explicitly).
    const offSink = makeSink();
    subs.add('box-off', offSink.res as never);
    const pending = askPrompt(prompts, subs, 'box-off', { kind: 'confirm', message: 'go?' });
    expect(offSink.writes).toHaveLength(1);
    expect(prompts.size()).toBe(1);
    expect(audited).toHaveLength(1);
    const ev = JSON.parse(/data: (\{.*\})/.exec(offSink.writes[0]!)![1]!) as { id: string };
    prompts.resolve(ev.id, 'n');
    await expect(pending).resolves.toEqual({ answer: 'n', cancelled: undefined });
  });

  it('auto-expires after ttlMs, resolving to the default answer', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-1', sink.res as never);

    const result = await askPrompt(
      prompts,
      subs,
      'box-1',
      { kind: 'confirm', message: 'go?' },
      { ttlMs: 20 },
    );
    expect(result).toEqual({ answer: 'n', cancelled: true });
    expect(prompts.size()).toBe(0);
    // one prompt-ask, then one prompt-resolved when the TTL fires.
    expect(sink.writes).toHaveLength(2);
    expect(sink.writes[0]).toContain('event: prompt-ask');
    expect(sink.writes[1]).toContain('event: prompt-resolved');
  });

  it('ttlMs expiry honours an explicit defaultAnswer', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const result = await askPrompt(
      prompts,
      subs,
      'box-1',
      { kind: 'confirm', message: 'go?', defaultAnswer: 'y' },
      { ttlMs: 20 },
    );
    expect(result).toEqual({ answer: 'y', cancelled: true });
  });

  it('a real answer before ttlMs wins and no second event is emitted', async () => {
    const prompts = new PendingPrompts();
    const subs = new PromptSubscribers();
    const sink = makeSink();
    subs.add('box-1', sink.res as never);

    const promise = askPrompt(
      prompts,
      subs,
      'box-1',
      { kind: 'confirm', message: 'go?' },
      { ttlMs: 30 },
    );
    const ev = JSON.parse(/data: (\{.*\})/.exec(sink.writes[0]!)![1]!) as { id: string };
    prompts.resolve(ev.id, 'y');
    await expect(promise).resolves.toEqual({ answer: 'y', cancelled: undefined });
    // Wait past the TTL: the cleared timer must not broadcast a second event.
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toContain('event: prompt-ask');
  });
});

describe('isPromptAnswerBody', () => {
  it('accepts well-formed bodies', () => {
    expect(isPromptAnswerBody({ id: 'x', answer: 'y' })).toBe(true);
    expect(isPromptAnswerBody({ id: 'x', answer: 'n', cancelled: true })).toBe(true);
  });
  it('rejects missing/invalid fields', () => {
    expect(isPromptAnswerBody(null)).toBe(false);
    expect(isPromptAnswerBody({})).toBe(false);
    expect(isPromptAnswerBody({ id: '', answer: 'y' })).toBe(false);
    expect(isPromptAnswerBody({ id: 'x', answer: 'maybe' })).toBe(false);
    expect(isPromptAnswerBody({ id: 'x', answer: 'y', cancelled: 'yes' })).toBe(false);
  });
});
