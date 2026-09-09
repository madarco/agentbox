import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Compositor } from '../src/dashboard/compositor.js';
import { NEW_BOX_ID, type SidebarBox } from '../src/dashboard/sidebar.js';

/**
 * The dashboard resolves each box's relay asynchronously (a hub box streams its
 * approvals from the control box, not this laptop), so `syncPromptSubscriptions`
 * claims the box's slot with a token and installs the real stream when the
 * resolve lands. These pin that bookkeeping — a leaked subscription here is an
 * SSE connection nothing can close.
 */

const closed: string[] = [];
const opened: Array<{ boxId: string; baseUrl: string; apiKey?: string }> = [];
/** Boxes whose subscription should immediately fail permanently (a non-200). */
const failWith = new Map<string, string>();
/** Each live subscription's `onPrompt`, so a test can push an event at it. */
const onPromptFor = new Map<string, (ev: unknown) => void>();
/** Answers the compositor POSTed, and whether the mock lets it win the claim. */
const answers: Array<Record<string, unknown>> = [];
let claimWins = true;

vi.mock('../src/wrapped-pty/prompt-client.js', () => ({
  subscribePrompts: (opts: {
    boxId: string;
    hubBaseUrl: string;
    hubApiKey?: string;
    onPrompt?: (ev: unknown) => void;
    onError?: (e: Error) => void;
  }) => {
    opened.push({ boxId: opts.boxId, baseUrl: opts.hubBaseUrl, apiKey: opts.hubApiKey });
    if (opts.onPrompt) onPromptFor.set(opts.boxId, opts.onPrompt);
    const msg = failWith.get(opts.boxId);
    if (msg) queueMicrotask(() => opts.onError?.(new Error(msg)));
    return { close: () => closed.push(opts.boxId) };
  },
  postAnswer: (o: { body: Record<string, unknown> }) => {
    answers.push(o.body);
    return Promise.resolve({
      ok: true,
      status: claimWins ? 200 : 404,
      claimed: claimWins,
    });
  },
}));

/** Minimal deps — the compositor does no terminal I/O until `run()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCompositor(over: Record<string, any> = {}): Compositor {
  const deps = {
    ptySpawn: (() => {
      throw new Error('not used');
    }) as never,
    termCtor: (() => {
      throw new Error('not used');
    }) as never,
    hubBaseUrl: 'http://127.0.0.1:8787',
    listCandidates: () => Promise.resolve([] as SidebarBox[]),
    resolveTarget: () => Promise.resolve({ kind: 'placeholder', lines: [] } as never),
    startClaude: () => Promise.resolve({ kind: 'placeholder', lines: [] } as never),
    startCodex: () => Promise.resolve({ kind: 'placeholder', lines: [] } as never),
    startOpencode: () => Promise.resolve({ kind: 'placeholder', lines: [] } as never),
    openShell: () => Promise.resolve(''),
    createNewBox: () => Promise.resolve({ kind: 'placeholder', lines: [] } as never),
    resumeBox: () => Promise.resolve(),
    pauseBox: () => Promise.resolve(),
    stopBox: () => Promise.resolve(),
    destroyBox: () => Promise.resolve(),
    openScreen: () => Promise.resolve(''),
    openCode: () => Promise.resolve(''),
    openUrl: () => Promise.resolve(''),
    ...over,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Compositor(deps as any, NEW_BOX_ID);
}

/** Reach the private bookkeeping the poll loop drives. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sync = (c: Compositor): void => (c as any).syncPromptSubscriptions();
const setBoxes = (c: Compositor, ids: string[]): void => {
  // Shaped like a real SidebarBox — the alert-band redraw renders these rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).boxes = ids.map((id) => ({ id, name: id, state: 'running' }));
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const streams = (c: Compositor): Map<string, unknown> => (c as any).promptStreams;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alerts = (c: Compositor): Map<string, unknown> => (c as any).activePrompts;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('compositor prompt subscriptions', () => {
  // The alert-band redraw writes escape sequences straight to process.stdout
  // (`out` is not injectable); swallow them so the suite output stays readable.
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes each box on the relay its own resolver returns', async () => {
    opened.length = 0;
    const c = makeCompositor({
      hubSourceFor: (boxId: string) =>
        Promise.resolve(
          boxId === 'hub-box' ? { baseUrl: 'https://plane.example', apiKey: 'tok' } : null,
        ),
    });
    setBoxes(c, ['local-box', 'hub-box']);
    sync(c);
    await flush();

    expect(opened).toContainEqual({
      boxId: 'hub-box',
      baseUrl: 'https://plane.example',
      apiKey: 'tok',
    });
    // A resolver returning null falls back to the global hub, no bearer.
    expect(opened).toContainEqual({
      boxId: 'local-box',
      baseUrl: 'http://127.0.0.1:8787',
      apiKey: undefined,
    });
  });

  it('does not leak a stream when a box leaves and re-enters mid-resolve', async () => {
    opened.length = 0;
    closed.length = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;

    const c = makeCompositor({
      // First resolve hangs until released; later ones resolve immediately, so
      // two attempts for the same box are in flight at once.
      hubSourceFor: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return null;
      },
    });

    setBoxes(c, ['flaky']);
    sync(c); // attempt A claims the slot, then blocks on the gate
    setBoxes(c, []);
    sync(c); // box vanished — dispose drops A's slot
    setBoxes(c, ['flaky']);
    sync(c); // attempt B claims a fresh slot
    await flush();

    release?.();
    await flush();
    await flush();

    // Whatever the interleaving, every stream that was opened is either tracked
    // (so dispose/teardown can close it) or already closed. Neither may be
    // orphaned — that is the leak this guards.
    const tracked = streams(c);
    const orphans = opened.filter((o) => !tracked.has(o.boxId) && !closed.includes(o.boxId));
    expect(orphans).toEqual([]);
    expect(tracked.size).toBeLessThanOrEqual(1);
  });

  it('surfaces a permanently-failed stream instead of looking like no approvals', async () => {
    opened.length = 0;
    failWith.clear();
    failWith.set('bad-token', 'SSE stream returned 401');

    const c = makeCompositor({ hubSourceFor: () => Promise.resolve(null) });
    setBoxes(c, ['bad-token']);
    sync(c);
    await flush();
    await flush();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notices = (c as any).activeNotices as Map<string, { message: string }>;
    expect(notices.get('bad-token')?.message).toContain('401');
    // The dead slot is released so it can be retried later, rather than sitting
    // in the map keeping the box permanently unsubscribed.
    expect(streams(c).has('bad-token')).toBe(false);

    // ...but not on the 1s poll cadence: a 401 would become a request/second.
    sync(c);
    await flush();
    expect(opened.filter((o) => o.boxId === 'bad-token')).toHaveLength(1);
    failWith.clear();
  });

  it('surfaces a plane it cannot authenticate to, rather than silently going local', async () => {
    opened.length = 0;
    failWith.clear();
    const c = makeCompositor({
      hubSourceFor: () =>
        Promise.resolve({
          baseUrl: 'http://127.0.0.1:8787',
          warning: 'approvals live on https://plane.example but no hub API key is available here',
        }),
    });
    setBoxes(c, ['no-token']);
    sync(c);
    await flush();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notices = (c as any).activeNotices as Map<string, { message: string }>;
    expect(notices.get('no-token')?.message).toContain('no hub API key');
  });

  it('drops the slot when the box is gone by the time the resolve lands', async () => {
    opened.length = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));

    const c = makeCompositor({
      hubSourceFor: async () => {
        await gate;
        return null;
      },
    });

    setBoxes(c, ['transient']);
    sync(c);
    setBoxes(c, []);
    sync(c); // disposed while the resolve is still in flight
    release?.();
    await flush();
    await flush();

    expect(streams(c).has('transient')).toBe(false);
    expect(opened).toEqual([]); // never opened a stream for a box that left
  });

  // An `open-link` offer is not an approval to render: the dashboard claims it
  // and opens it on this machine. It watches EVERY visible box, so an attach
  // footer on the same box is a live competitor for the same link — hence
  // claim-then-open, and open only on a win.
  it('claims an auto open-link and opens it on this machine', async () => {
    opened.length = 0;
    answers.length = 0;
    onPromptFor.clear();
    claimWins = true;
    const urls: string[] = [];
    const c = makeCompositor({
      hubSourceFor: () => Promise.resolve(null),
      openRawUrl: (u: string) => urls.push(u),
    });
    setBoxes(c, ['b1']);
    sync(c);
    await flush();

    onPromptFor.get('b1')?.({
      id: 'p1',
      kind: 'open-link',
      message: 'Open link from box b1?',
      url: 'https://a.test',
      autoOpen: true,
    });
    await flush();
    await flush();

    expect(answers).toEqual([{ id: 'p1', answer: 'y', openedByClient: true }]);
    expect(urls).toEqual(['https://a.test']);
    // Not an alert row: it was never a question.
    expect(alerts(c).has('b1')).toBe(false);
  });

  it('opens nothing when another surface claimed the link first', async () => {
    answers.length = 0;
    onPromptFor.clear();
    claimWins = false;
    const urls: string[] = [];
    const c = makeCompositor({
      hubSourceFor: () => Promise.resolve(null),
      openRawUrl: (u: string) => urls.push(u),
    });
    setBoxes(c, ['b1']);
    sync(c);
    await flush();

    onPromptFor.get('b1')?.({
      id: 'p1',
      kind: 'open-link',
      message: 'Open link from box b1?',
      url: 'https://a.test',
      autoOpen: true,
    });
    await flush();
    await flush();

    expect(answers).toHaveLength(1);
    expect(urls).toEqual([]);
  });
});
