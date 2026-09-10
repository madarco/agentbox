import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CarryItem, PromptRequest } from '@agentbox/core';
import {
  buildCarryPrompt,
  carryGrantId,
  runCarryGate,
  toFileRow,
} from '../src/prompts/carry-gate.js';
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
    ).rejects.toThrow(/these files can't be copied/);
  });
});

describe('the standing carry grant', () => {
  /** The grant id for a set of items, as a caller would have stored it. */
  async function grantFor(items: CarryItem[]): Promise<string> {
    const { entries } = await resolveCarry(items, { projectRoot: root });
    return carryGrantId(entries);
  }

  it('approves a granted list without asking', async () => {
    const approvedGrantId = await grantFor([item()]);
    const seen: string[] = [];
    const r = await runCarryGate({
      projectRoot: root,
      items: [item()],
      ask: refuses, // shown at all = failure
      approvedGrantId,
      onLog: (l) => seen.push(l),
    });
    expect(r.decision).toBe('approve');
    expect(r.decision === 'approve' && r.entries).toHaveLength(1);
    expect(r.decision === 'approve' && r.fromGrant).toBe(true);
    expect(seen.join('\n')).toMatch(/approved earlier for this project \(1 file, list unchanged\)/);
  });

  it('still matches when a carried file CHANGES SIZE', async () => {
    // The whole point: the grant is keyed on the list, not on contents. The
    // prompt id, which includes each row's bytes, deliberately is not.
    const changing = join(root, 'grows.env');
    await writeFile(changing, 'A=1\n');
    const items = [item({ src: changing, dest: '~/.grows.env' })];
    const before = await grantFor(items);
    const promptBefore = buildCarryPrompt(
      (await resolveCarry(items, { projectRoot: root })).entries,
    ).id;

    await writeFile(changing, 'A=1\nB=2\nC=3\n');
    expect(await grantFor(items)).toBe(before);
    const promptAfter = buildCarryPrompt(
      (await resolveCarry(items, { projectRoot: root })).entries,
    ).id;
    expect(promptAfter).not.toBe(promptBefore);

    const r = await runCarryGate({
      projectRoot: root,
      items,
      ask: refuses,
      approvedGrantId: before,
    });
    expect(r.decision).toBe('approve');
  });

  it('asks again when the list itself changes', async () => {
    const approvedGrantId = await grantFor([item()]);
    for (const changed of [
      [item({ dest: '~/.elsewhere.env' })],
      [item(), item({ dest: '~/.second.env' })],
      [item({ mode: 0o600 })],
    ]) {
      const asked: PromptRequest[] = [];
      const r = await runCarryGate({
        projectRoot: root,
        items: changed,
        ask: picks('approve', asked),
        approvedGrantId,
      });
      expect(asked).toHaveLength(1);
      expect(r.decision === 'approve' && r.fromGrant).toBeUndefined();
    }
  });

  it('re-asks on --carry ask, and hands back the id to store', async () => {
    const approvedGrantId = await grantFor([item()]);
    const asked: PromptRequest[] = [];
    const r = await runCarryGate({
      projectRoot: root,
      items: [item()],
      ask: picks('approve', asked),
      approvedGrantId,
      carryAsk: true,
    });
    expect(asked).toHaveLength(1);
    expect(r.decision === 'approve' && r.grantId).toBe(approvedGrantId);
    expect(r.decision === 'approve' && r.fromGrant).toBeUndefined();
  });

  it('does not turn --carry-yes into a standing grant', async () => {
    // A scripted bypass is not a human reading the table: it approves the run
    // and reports no fresh approval, so the caller stores nothing.
    const r = await runCarryGate({
      projectRoot: root,
      items: [item()],
      ask: refuses,
      carryYes: true,
    });
    expect(r.decision === 'approve' && r.fromGrant).toBeUndefined();
  });

  it('is a different id space from the prompt', async () => {
    const { entries } = await resolveCarry([item()], { projectRoot: root });
    expect(carryGrantId(entries)).toMatch(/^carry-grant:[0-9a-f]{12}$/);
    expect(carryGrantId(entries)).not.toBe(buildCarryPrompt(entries).id);
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
  it('describes a missing entry and a folder in plain words', async () => {
    const dir = join(root, 'tree');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a'), 'x');
    const { entries } = await resolveCarry(
      [item({ src: join(root, 'absent'), optional: true }), item({ src: dir, dest: '~/tree' })],
      { projectRoot: root },
    );
    const rows = entries.map(toFileRow);
    expect(rows[0]!.flags).toContain('not on this machine');
    expect(rows[0]!.kind).toBe('missing');
    expect(rows[0]!.bytes).toBeUndefined();
    expect(rows[1]!.flags).toContain('folder');
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
