import { describe, expect, it } from 'vitest';
import { createInputRouter } from '../../src/wrapped-pty/input-router.js';
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

  it('forwards a binary control byte (Ctrl-a) unchanged', () => {
    const s = setup();
    s.router.feed(Buffer.from([0x01])); // Ctrl-a — used by tmux as a prefix; must reach pty intact
    expect(s.forwarded[0]).toEqual(Buffer.from([0x01]));
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
