import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CarryItem, PromptRequest } from '@agentbox/core';
import { buildCarryPrompt, runCarryGate, toFileRow } from '../src/prompts/carry-gate.js';
import { resolveCarry } from '../src/prompts/carry-resolve.js';

/**
 * The carry gate with an injected asker — the same decision the CLI, the hub's
 * preflight, and a replayed answer map all run. Touches a temp dir only.
 */
let root: string;
let src: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentbox-carry-gate-'));
  src = join(root, 'secret.env');
  await writeFile(src, 'TOKEN=abc\n');
});

const item = (over: Partial<CarryItem> = {}): CarryItem => ({
  src,
  dest: '~/.secret.env',
  optional: false,
  ...over,
});

/** An asker that always answers `value`, recording what it was shown. */
function picks(value: string, seen?: PromptRequest[]) {
  return async (req: PromptRequest) => {
    seen?.push(req);
    return { id: req.id, value };
  };
}

const refuses = () => {
  throw new Error('prompt must not be shown');
};

describe('runCarryGate', () => {
  it('approves an empty block without asking', async () => {
    const r = await runCarryGate({ projectRoot: root, items: [], ask: refuses });
    expect(r).toEqual({ decision: 'approve', entries: [] });
  });

  it('maps each answer to its decision', async () => {
    const base = { projectRoot: root, items: [item()] };
    const approved = await runCarryGate({ ...base, ask: picks('approve') });
    expect(approved.decision).toBe('approve');
    expect(approved.decision === 'approve' && approved.entries).toHaveLength(1);

    expect((await runCarryGate({ ...base, ask: picks('skip-this-run') })).decision).toBe('skip');
    expect((await runCarryGate({ ...base, ask: picks('cancel') })).decision).toBe('cancel');
  });

  it('treats a dismissal, and an answer it does not understand, as cancel', async () => {
    const base = { projectRoot: root, items: [item()] };
    const dismissed = await runCarryGate({
      ...base,
      ask: async (req) => ({ id: req.id, value: 'approve', cancelled: true }),
    });
    expect(dismissed.decision).toBe('cancel');
    expect((await runCarryGate({ ...base, ask: picks('who-knows') })).decision).toBe('cancel');
  });

  it('lets the flags decide before anyone is asked', async () => {
    const base = { projectRoot: root, items: [item()], ask: refuses };
    expect((await runCarryGate({ ...base, carryYes: true })).decision).toBe('approve');
    expect((await runCarryGate({ ...base, carrySkip: true })).decision).toBe('skip');
  });

  it('throws on a resolver error before asking anything', async () => {
    await expect(
      runCarryGate({
        projectRoot: root,
        items: [item({ src: join(root, 'nope.env') })],
        ask: refuses,
      }),
    ).rejects.toThrow(/carry: refused to proceed/);
  });
});

describe('buildCarryPrompt', () => {
  it('is required, cancels by default, and carries the file table', async () => {
    const { entries } = await resolveCarry([item()], { projectRoot: root });
    const req = buildCarryPrompt(entries);
    expect(req.topic).toBe('carry');
    expect(req.kind).toBe('select');
    // A silent answer would move host secrets, so there is no safe fallback.
    expect(req.required).toBe(true);
    expect(req.fallback.value).toBe('cancel');
    expect(req.nonInteractiveHint).toMatch(/AGENTBOX_CARRY_YES=1/);
    expect(req.detail).toMatchObject({ type: 'file-table', totalBytes: 10 });
    expect(req.detail?.type === 'file-table' && req.detail.rows).toHaveLength(1);
  });

  it('is content-addressed over the question, not the run', async () => {
    const { entries } = await resolveCarry([item()], { projectRoot: root });
    expect(buildCarryPrompt(entries).id).toBe(buildCarryPrompt(entries).id);

    // A changed destination is a different question, so a preflight answer for
    // the old one cannot be replayed onto it.
    const other = await resolveCarry([item({ dest: '~/.elsewhere.env' })], { projectRoot: root });
    expect(buildCarryPrompt(entries).id).not.toBe(buildCarryPrompt(other.entries).id);
  });
});

describe('toFileRow', () => {
  it('flags an optional entry, a dir, and a symlink out of $HOME', async () => {
    const dir = join(root, 'tree');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a'), 'x');
    const { entries } = await resolveCarry(
      [item({ src: join(root, 'absent'), optional: true }), item({ src: dir, dest: '~/tree' })],
      { projectRoot: root },
    );
    const rows = entries.map(toFileRow);
    expect(rows[0]!.flags).toContain('optional');
    expect(rows[0]!.kind).toBe('missing');
    expect(rows[0]!.bytes).toBeUndefined();
    expect(rows[1]!.flags).toContain('dir');
  });

  it('formats mode as octal and keeps an explicit uid', async () => {
    const { entries } = await resolveCarry([item({ mode: 0o600, user: 0 })], {
      projectRoot: root,
    });
    const row = toFileRow(entries[0]!);
    expect(row.mode).toBe('0600');
    expect(row.user).toBe(0);
  });
});
