import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Scratch HOME before the import: STATE_DIR is fixed at module load, and the
// lender's account secret lives under it. Never the real ~/.agentbox.
const home = mkdtempSync(join(tmpdir(), 'agentbox-lender-home-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { borrowedCredentialCarry } = await import('../src/borrowed-credentials.js');

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("a borrowed login uses the LENDER's account (llm-accounts Phase 3)", () => {
  it('carries the named account secret, not the default login', async () => {
    const secretDir = join(home, '.agentbox', 'credentials', 'codex');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, 'work.json'), '{"tokens":{"refresh_token":"b"}}');
    const defaultLookups: string[] = [];
    const entries = await borrowedCredentialCarry(
      ['codex'],
      undefined,
      (agent) => {
        defaultLookups.push(agent);
        return Promise.resolve({ path: '/default/codex-credentials.json', text: '{}' });
      },
      { codex: 'work' },
    );
    expect(entries.map((e) => e.absSrc)).toEqual([join(secretDir, 'work.json')]);
    expect(defaultLookups).toEqual([]);
  });
});
