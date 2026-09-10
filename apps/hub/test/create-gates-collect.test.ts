import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { writeCarryGrant } from '@agentbox/config';
import { collectAsker } from '../lib/prompts/askers';
import { runCreateGates } from '../lib/prompts/create-gates';

/**
 * The preflight learns its questions by running the REAL gates with a
 * collecting asker. That only works if collection reaches every gate — and a
 * collecting asker answers each prompt with its own fallback, which for
 * `carry:` is `cancel`.
 *
 * Without `collecting: true` the carry gate aborted the run and the model-auth
 * question never appeared in the list, so an OpenClaw box created from the tray
 * or the web UI silently came up with no model provider. This is the guard.
 */
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentbox-preflight-'));
  await writeFile(join(root, 'secret.env'), 'TOKEN=abc\n');
  await writeFile(
    join(root, 'agentbox.yaml'),
    'carry:\n  - src: ./secret.env\n    dest: ~/.secret.env\n',
  );
});

describe('runCreateGates in collecting mode', () => {
  it('keeps going past a gate whose fallback is cancel', async () => {
    const asker = collectAsker();
    const res = await runCreateGates({
      workspace: root,
      // An agent that declares `modelAuth`, so a second gate exists to reach.
      agent: 'openclaw',
      ask: asker.ask,
      collecting: true,
    });
    expect(asker.collected.map((p) => p.topic)).toContain('carry');
    // The whole point: carry answered `cancel` (its fallback) and the run did
    // NOT stop there.
    expect(res.cancelled).toBe(false);
  });

  it('still aborts on cancel when it is deciding, not collecting', async () => {
    const res = await runCreateGates({
      workspace: root,
      agent: 'none',
      ask: (req) => Promise.resolve({ id: req.id, value: 'cancel' }),
    });
    expect(res.cancelled).toBe(true);
    expect(res.carry).toEqual([]);
  });

  it('an explicit borrowCredentials wins, empty array included', async () => {
    const refuses = () => {
      throw new Error('must not ask when the answer was given up front');
    };
    // The API equivalent of `--model-auth`. An empty array is a deliberate
    // "none" and must not fall through to anything else — it used to lose to a
    // client-supplied list because the merge happened after the gate.
    const chosen = await runCreateGates({
      workspace: root,
      agent: 'openclaw',
      ask: refuses,
      carryYes: true,
      borrowCredentials: ['codex'],
    });
    expect(chosen.borrowCredentials).toEqual(['codex']);

    const declined = await runCreateGates({
      workspace: root,
      agent: 'openclaw',
      ask: refuses,
      carryYes: true,
      borrowCredentials: [],
    });
    expect(declined.borrowCredentials).toEqual([]);
  });

  it('carryYes approves without asking - the clone path', async () => {
    const res = await runCreateGates({
      workspace: root,
      agent: 'none',
      ask: () => {
        throw new Error('must not ask when carryYes was set');
      },
      carryYes: true,
    });
    expect(res.cancelled).toBe(false);
    expect(res.carry).toHaveLength(1);
  });

  it('asks no carry question once the project has granted that list', async () => {
    // The reason the web modal and the tray card stop re-asking: the preflight
    // runs the same gate, so a stored grant removes the question at the source.
    const granted = await runCreateGates({
      workspace: root,
      agent: 'none',
      ask: (req) => Promise.resolve({ id: req.id, value: 'approve' }),
    });
    expect(granted.carryGrantId).toMatch(/^carry-grant:/);
    expect(granted.carryFromGrant).toBeUndefined();
    await writeCarryGrant(root, {
      approvedId: granted.carryGrantId!,
      approvedAt: new Date().toISOString(),
      files: [],
    });

    const asker = collectAsker();
    const res = await runCreateGates({
      workspace: root,
      agent: 'openclaw',
      ask: asker.ask,
      collecting: true,
    });
    // No question to show — and the files are still approved, so the create
    // that follows carries them.
    expect(asker.collected.map((p) => p.topic)).not.toContain('carry');
    expect(res.carry).toHaveLength(1);
    expect(res.carryFromGrant).toBe(true);
    expect(res.cancelled).toBe(false);
  });

  it('asks nothing for a project with no carry block and no borrowing agent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'agentbox-preflight-bare-'));
    const asker = collectAsker();
    const res = await runCreateGates({
      workspace: bare,
      agent: 'none',
      ask: asker.ask,
      collecting: true,
    });
    expect(asker.collected).toEqual([]);
    expect(res.cancelled).toBe(false);
  });
});
