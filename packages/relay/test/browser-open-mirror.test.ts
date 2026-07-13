import { describe, expect, it, vi } from 'vitest';

/**
 * `browser.open.mirror` is the migration proof for the `open-link` prompt kind:
 * one flow, two clients, and the host must open the URL ONLY for a plain
 * terminal "yes". A hub/tray client opens the link itself (it may be on a
 * different machine than the relay — the whole point of the control-plane
 * design) and reports `openedByClient`, at which point a host-side `open` would
 * be a stray browser tab on a server nobody is sitting at.
 *
 * The executor reaches the host opener via `await import('node:child_process')`,
 * so we mock the module to observe the decision rather than re-stating it.
 */
const spawn = vi.hoisted(() =>
  vi.fn<(cmd: string, args: string[]) => { unref: () => void }>(() => ({ unref: () => {} })),
);
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

const { executeCloudAction } = await import('../src/host-actions.js');
const { PendingPrompts, PromptSubscribers } = await import('../src/prompts.js');
import type { HostAction } from '../src/types.js';
import type { PromptAskEvent } from '../src/types.js';

const URL_ = 'https://example.com/from-the-box';

function makeSink(): { events: PromptAskEvent[]; res: { write(s: string): true } } {
  const events: PromptAskEvent[] = [];
  return {
    events,
    res: {
      write(s: string): true {
        const m = /event: prompt-ask\ndata: (.*)\n\n$/s.exec(s);
        if (m?.[1]) events.push(JSON.parse(m[1]) as PromptAskEvent);
        return true;
      },
    },
  };
}

function action(): HostAction {
  return {
    id: 'action-1',
    boxId: 'box1',
    method: 'browser.open.mirror',
    params: { url: URL_ },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Run the mirror action and answer its prompt the way `answer` says. Returns
 * the raised prompt event so the caller can assert its wire shape.
 */
async function runMirror(answer: {
  answer: 'y' | 'n';
  openedByClient?: boolean;
}): Promise<PromptAskEvent> {
  const prompts = new PendingPrompts();
  const subscribers = new PromptSubscribers();
  const sink = makeSink();
  subscribers.add('box1', sink.res as never);

  const done = executeCloudAction(action(), {
    backendName: 'daytona',
    boxId: 'box1',
    boxName: 'b1',
    prompts,
    subscribers,
    log: () => {},
  } as Parameters<typeof executeCloudAction>[1]);

  // The prompt is broadcast synchronously inside askPrompt; answer it.
  await vi.waitFor(() => {
    expect(sink.events).toHaveLength(1);
  });
  const ev = sink.events[0];
  if (!ev) throw new Error('no prompt was raised');
  prompts.resolve(ev.id, answer.answer, undefined, answer.openedByClient);
  await done;
  return ev;
}

describe('browser.open.mirror → open-link prompt', () => {
  it('raises an open-link prompt carrying the URL, and asks for the host fallback', async () => {
    spawn.mockClear();
    const ev = await runMirror({ answer: 'n' });
    expect(ev.kind).toBe('open-link');
    expect(ev.url).toBe(URL_);
    expect(ev.hostOpen).toBe(true);
    // Also mirrored into `detail` so a client that predates the kind (the
    // current tray) still shows a copyable link.
    expect(ev.detail).toBe(URL_);
  });

  it('opens on the host for a plain terminal yes (the pre-existing behavior)', async () => {
    spawn.mockClear();
    await runMirror({ answer: 'y' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[1]).toEqual([URL_]);
  });

  it('does NOT open on the host when the client already opened the link', async () => {
    spawn.mockClear();
    await runMirror({ answer: 'y', openedByClient: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does NOT open on the host when denied', async () => {
    spawn.mockClear();
    await runMirror({ answer: 'n' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
