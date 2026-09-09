import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
