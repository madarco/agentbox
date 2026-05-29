import { describe, expect, it } from 'vitest';
import {
  createInputRouter,
  type LeaderAction,
} from '../../src/wrapped-pty/input-router.js';
import type { PromptAnswerBody } from '@agentbox/relay';

interface Setup {
  forwarded: Buffer[];
  answers: PromptAnswerBody[];
  router: ReturnType<typeof createInputRouter>;
}

function setup(): Setup {
  const forwarded: Buffer[] = [];
  const answers: PromptAnswerBody[] = [];
  const router = createInputRouter({
    onForward: (b) => forwarded.push(b),
    onAnswer: (a) => answers.push(a),
  });
  return { forwarded, answers, router };
}

describe('input router (steady state)', () => {
  it('forwards every byte unchanged when no prompt is active', () => {
    const s = setup();
    s.router.feed(Buffer.from('hello\r'));
    expect(Buffer.concat(s.forwarded).toString('utf8')).toBe('hello\r');
    expect(s.answers).toHaveLength(0);
  });

  it('forwards a binary control byte (Ctrl-a) unchanged when the leader is disabled', () => {
    const s = setup(); // no leaderChords → Ctrl-a is a plain byte
    s.router.feed(Buffer.from([0x01]));
    expect(s.forwarded[0]).toEqual(Buffer.from([0x01]));
  });
});

interface LeaderSetup {
  forwarded: Buffer[];
  leaderEvents: boolean[];
  actions: LeaderAction[];
  router: ReturnType<typeof createInputRouter>;
  fire: () => void;
}

function leaderSetup(): LeaderSetup {
  const forwarded: Buffer[] = [];
  const leaderEvents: boolean[] = [];
  const actions: LeaderAction[] = [];
  const timers: Array<{ id: number; fn: () => void }> = [];
  let seq = 0;
  const router = createInputRouter({
    onForward: (b) => forwarded.push(b),
    onAnswer: () => {},
    leaderChords: { c: 'code', s: 'screen', u: 'url', d: 'detach' },
    onLeaderChange: (open) => leaderEvents.push(open),
    onAction: (n) => actions.push(n),
    setTimer: (_ms, fn) => {
      const id = ++seq;
      timers.push({ id, fn });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const fire = (): void => {
    const cur = timers.splice(0, timers.length);
    for (const t of cur) t.fn();
  };
  return { forwarded, leaderEvents, actions, router, fire };
}

const fwd = (s: LeaderSetup): string => Buffer.concat(s.forwarded).toString('latin1');

describe('input router (Ctrl+a leader)', () => {
  it('Ctrl+a opens the menu without forwarding the byte', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01]));
    expect(s.leaderEvents).toEqual([true]);
    expect(fwd(s)).toBe('');
    expect(s.actions).toHaveLength(0);
  });

  it('c / s / u / d dispatch their actions and close the menu', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01, 0x63])); // ^A c
    s.router.feed(Buffer.from([0x01, 0x73])); // ^A s
    s.router.feed(Buffer.from([0x01, 0x75])); // ^A u
    s.router.feed(Buffer.from([0x01, 0x64])); // ^A d
    expect(s.actions).toEqual(['code', 'screen', 'url', 'detach']);
    expect(s.leaderEvents).toEqual([true, false, true, false, true, false, true, false]);
    expect(fwd(s)).toBe('');
  });

  it('chord matching is case-insensitive', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01, 0x53])); // ^A S
    expect(s.actions).toEqual(['screen']);
  });

  it('double Ctrl+a sends one literal Ctrl+a and closes the menu', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01, 0x01]));
    expect(fwd(s)).toBe('\x01');
    expect(s.actions).toHaveLength(0);
    expect(s.leaderEvents).toEqual([true, false]);
  });

  it('an unrecognized chord closes the menu and forwards the key', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01, 0x7a])); // ^A z
    expect(fwd(s)).toBe('z');
    expect(s.actions).toHaveLength(0);
    expect(s.leaderEvents).toEqual([true, false]);
  });

  it('Esc dismisses the menu without forwarding anything', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01, 0x1b]));
    expect(fwd(s)).toBe('');
    expect(s.actions).toHaveLength(0);
    expect(s.leaderEvents).toEqual([true, false]);
  });

  it('the menu auto-closes after the timeout (nothing forwarded)', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01]));
    expect(s.leaderEvents).toEqual([true]);
    s.fire();
    expect(s.leaderEvents).toEqual([true, false]);
    expect(fwd(s)).toBe('');
  });

  it('bytes typed before Ctrl+a are forwarded; the chord still fires', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('hi\x01s', 'latin1'));
    expect(fwd(s)).toBe('hi');
    expect(s.actions).toEqual(['screen']);
  });

  it('a chord split across two reads still resolves', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01]));
    s.router.feed(Buffer.from([0x73])); // 's'
    expect(s.actions).toEqual(['screen']);
    expect(s.leaderEvents).toEqual([true, false]);
  });

  it('forwards plain input unchanged when no leader byte is present', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('echo hi\r'));
    expect(fwd(s)).toBe('echo hi\r');
    expect(s.leaderEvents).toHaveLength(0);
  });

  it('a relay prompt cancels an open leader and still captures the answer', async () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01]));
    expect(s.leaderEvents).toEqual([true]);
    const p = s.router.capture({ id: 'q', kind: 'confirm', message: 'go?' });
    expect(s.leaderEvents).toEqual([true, false]);
    s.router.feed(Buffer.from('y'));
    await expect(p).resolves.toEqual({ id: 'q', answer: 'y' });
  });
});

describe('input router (active prompt)', () => {
  it("'y' resolves with answer 'y'", async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q1', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from('y'));
    await expect(p).resolves.toEqual({ id: 'q1', answer: 'y' });
    expect(s.answers).toEqual([{ id: 'q1', answer: 'y' }]);
    expect(s.forwarded).toHaveLength(0);
  });

  it("'N' resolves with answer 'n'", async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q2', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from('N'));
    await expect(p).resolves.toEqual({ id: 'q2', answer: 'n' });
  });

  it('Esc resolves with answer "n" + cancelled:true', async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q3', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from([0x1b]));
    await expect(p).resolves.toEqual({ id: 'q3', answer: 'n', cancelled: true });
  });

  it('a CSI mouse-click sequence (\\x1b[<0;10;20M) does NOT cancel', async () => {
    const s = setup();
    let settled = false;
    const p = s.router.capture({ id: 'q-mouse', kind: 'confirm', message: 'go?' });
    p.then(() => {
      settled = true;
    }).catch(() => {
      settled = true;
    });
    // SGR mouse press; same shape claude/tmux emit when mouse tracking is on.
    s.router.feed(Buffer.from('\x1b[<0;10;20M'));
    // Yield to the microtask queue so any (incorrect) resolve would land.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(s.answers).toHaveLength(0);
    expect(s.forwarded).toHaveLength(0);
    // The prompt is still active; a real 'y' should still resolve normally.
    s.router.feed(Buffer.from('y'));
    await expect(p).resolves.toEqual({ id: 'q-mouse', answer: 'y' });
  });

  it('an arrow-key CSI (\\x1b[A) does NOT cancel', async () => {
    const s = setup();
    let settled = false;
    const p = s.router.capture({ id: 'q-arrow', kind: 'confirm', message: 'go?' });
    p.then(() => {
      settled = true;
    }).catch(() => {
      settled = true;
    });
    s.router.feed(Buffer.from('\x1b[A'));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    s.router.feed(Buffer.from('n'));
    await expect(p).resolves.toEqual({ id: 'q-arrow', answer: 'n' });
  });

  it('Ctrl-c resolves with answer "n" + cancelled:true', async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q4', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from([0x03]));
    await expect(p).resolves.toEqual({ id: 'q4', answer: 'n', cancelled: true });
  });

  it('Enter accepts the default answer (n when unset)', async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q5', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from([0x0d]));
    await expect(p).resolves.toEqual({ id: 'q5', answer: 'n' });
  });

  it('Enter accepts the explicit defaultAnswer "y"', async () => {
    const s = setup();
    const p = s.router.capture({
      id: 'q6',
      kind: 'confirm',
      message: 'go?',
      defaultAnswer: 'y',
    });
    s.router.feed(Buffer.from([0x0d]));
    await expect(p).resolves.toEqual({ id: 'q6', answer: 'y' });
  });

  it('unrecognized keys during a prompt are dropped, not forwarded', () => {
    const s = setup();
    void s.router.capture({ id: 'q7', kind: 'confirm', message: 'go?' });
    s.router.feed(Buffer.from('Q'));
    s.router.feed(Buffer.from([0x09])); // Tab
    expect(s.forwarded).toHaveLength(0);
    expect(s.answers).toHaveLength(0);
  });

  it("a settling byte + trailing bytes: settle, then forward the rest", async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q8', kind: 'confirm', message: 'go?' });
    // "y\necho hi" — the 'y' settles; the rest should flow to the pty.
    s.router.feed(Buffer.from('y\necho hi'));
    await expect(p).resolves.toEqual({ id: 'q8', answer: 'y' });
    expect(Buffer.concat(s.forwarded).toString('utf8')).toBe('\necho hi');
  });

  it('a fresh capture supersedes a pending one (the old is cancelled)', async () => {
    const s = setup();
    const first = s.router.capture({ id: 'old', kind: 'confirm', message: 'q1' });
    const second = s.router.capture({ id: 'new', kind: 'confirm', message: 'q2' });
    s.router.feed(Buffer.from('y'));
    await expect(first).resolves.toEqual({ id: 'old', answer: 'n', cancelled: true });
    await expect(second).resolves.toEqual({ id: 'new', answer: 'y' });
  });

  it('abort rejects the in-flight capture', async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q9', kind: 'confirm', message: 'go?' });
    s.router.abort('pty-exit');
    await expect(p).rejects.toThrow(/pty exited/);
  });

  it('dispose rejects any in-flight capture', async () => {
    const s = setup();
    const p = s.router.capture({ id: 'q10', kind: 'confirm', message: 'go?' });
    s.router.dispose();
    await expect(p).rejects.toThrow(/disposed/);
  });
});

interface PasteSetup {
  forwarded: Buffer[];
  calls: () => number;
  resolveAll: () => void;
  router: ReturnType<typeof createInputRouter>;
}

function pasteSetup(): PasteSetup {
  const forwarded: Buffer[] = [];
  const resolvers: Array<() => void> = [];
  let calls = 0;
  const router = createInputRouter({
    onForward: (b) => forwarded.push(b),
    onAnswer: () => {},
    onPasteImage: () =>
      new Promise<void>((res) => {
        calls++;
        resolvers.push(res);
      }),
  });
  return {
    forwarded,
    calls: () => calls,
    resolveAll: () => {
      for (const r of resolvers.splice(0)) r();
    },
    router,
  };
}

const CTRL_V = 0x16;
const flushMicrotasks = (): Promise<void> =>
  new Promise((r) => setImmediate(r));

describe('input router (Ctrl+V image paste)', () => {
  it('forwards Ctrl+V verbatim when no paste hook is set', () => {
    const s = setup();
    s.router.feed(Buffer.from([CTRL_V]));
    expect(Buffer.concat(s.forwarded)).toEqual(Buffer.from([CTRL_V]));
  });

  it('intercepts Ctrl+V: awaits the hook, then re-emits exactly one Ctrl+V', async () => {
    const s = pasteSetup();
    s.router.feed(Buffer.from([CTRL_V]));
    await flushMicrotasks();
    expect(s.calls()).toBe(1);
    expect(s.forwarded).toHaveLength(0); // nothing forwarded until the load finishes
    s.resolveAll();
    await flushMicrotasks();
    expect(Buffer.concat(s.forwarded)).toEqual(Buffer.from([CTRL_V]));
  });

  it('debounces Ctrl+V while a paste is in flight', async () => {
    const s = pasteSetup();
    s.router.feed(Buffer.from([CTRL_V]));
    s.router.feed(Buffer.from([CTRL_V]));
    await flushMicrotasks();
    expect(s.calls()).toBe(1); // second press dropped
    s.resolveAll();
    await flushMicrotasks();
    expect(Buffer.concat(s.forwarded)).toEqual(Buffer.from([CTRL_V]));
  });

  it('forwards surrounding bytes immediately and defers only the Ctrl+V', async () => {
    const s = pasteSetup();
    s.router.feed(Buffer.from('ab\x16cd'));
    await flushMicrotasks();
    expect(Buffer.concat(s.forwarded).toString('utf8')).toBe('abcd');
    s.resolveAll();
    await flushMicrotasks();
    expect(Buffer.concat(s.forwarded)).toEqual(Buffer.from('abcd\x16'));
  });
});

describe('input router (enhanced keyboard: kitty / modifyOtherKeys)', () => {
  it('kitty-encoded Ctrl+a (ESC[97;5u) opens the menu without forwarding', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[97;5u', 'latin1'));
    expect(s.leaderEvents).toEqual([true]);
    expect(fwd(s)).toBe('');
    expect(s.actions).toHaveLength(0);
  });

  it('modifyOtherKeys Ctrl+a (ESC[27;5;97~) opens the menu', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[27;5;97~', 'latin1'));
    expect(s.leaderEvents).toEqual([true]);
    expect(fwd(s)).toBe('');
  });

  it('dispatches a kitty-encoded chord after a kitty leader', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[97;5u', 'latin1')); // Ctrl+a
    s.router.feed(Buffer.from('\x1b[99u', 'latin1')); // 'c'
    expect(s.actions).toEqual(['code']);
    expect(s.leaderEvents).toEqual([true, false]);
    expect(fwd(s)).toBe('');
  });

  it('handles a raw leader followed by a kitty-encoded chord (mixed)', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from([0x01])); // raw Ctrl+a
    s.router.feed(Buffer.from('\x1b[100;1u', 'latin1')); // 'd' with no mods
    expect(s.actions).toEqual(['detach']);
  });

  it('double kitty Ctrl+a sends one literal Ctrl+a and closes the menu', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[97;5u\x1b[97;5u', 'latin1'));
    expect(fwd(s)).toBe('\x01');
    expect(s.actions).toHaveLength(0);
    expect(s.leaderEvents).toEqual([true, false]);
  });

  it('does NOT treat a cursor key (ESC[A) as the leader', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[A', 'latin1'));
    expect(s.leaderEvents).toEqual([]);
    expect(fwd(s)).toBe('\x1b[A');
  });

  it('does NOT treat a plain kitty key (no Ctrl) as the leader', () => {
    const s = leaderSetup();
    s.router.feed(Buffer.from('\x1b[97u', 'latin1')); // 'a', no modifiers
    expect(s.leaderEvents).toEqual([]);
    expect(fwd(s)).toBe('\x1b[97u');
  });
});
