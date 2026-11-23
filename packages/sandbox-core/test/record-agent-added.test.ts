import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordAgentAdded } from '../src/state.js';

/**
 * `agentbox openclaw <existing agentless box>`: the agent is recorded before the
 * box is (re)started, so its registration names it and it gets its units.
 */
describe('recordAgentAdded', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-added-'));
    path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        boxes: [
          { id: 'plain', name: 'plain', workspacePath: '/w', createdAt: '' },
          { id: 'tui', name: 'tui', workspacePath: '/w', createdAt: '', agents: ['claude'] },
        ],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives an agentless box the agent, and appends to one that has some', async () => {
    expect((await recordAgentAdded('plain', 'openclaw', path))?.agents).toEqual(['openclaw']);
    expect((await recordAgentAdded('tui', 'openclaw', path))?.agents).toEqual([
      'claude',
      'openclaw',
    ]);
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
      boxes: { id: string; agents?: string[] }[];
    };
    expect(onDisk.boxes.find((b) => b.id === 'plain')?.agents).toEqual(['openclaw']);
  });

  it('is idempotent and answers undefined for an unknown box', async () => {
    await recordAgentAdded('plain', 'openclaw', path);
    expect((await recordAgentAdded('plain', 'openclaw', path))?.agents).toEqual(['openclaw']);
    expect(await recordAgentAdded('nope', 'openclaw', path)).toBeUndefined();
  });
});
