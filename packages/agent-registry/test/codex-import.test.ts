import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodexImportScript } from '../src/specs/_codex-import.js';

const run = promisify(execFile);

/**
 * The ingest is GENERATED shell wrapping generated JS, so the only test worth
 * having runs it. Pure and local: a temp dir, no docker and no network.
 *
 * The tokens below are synthetic. The JWT is real in SHAPE only — the script
 * reads `exp` out of it, which is the field Phase 0 proved must not be faked.
 */
let dir: string;
let script: string;

function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSeconds })}.sig`;
}

const EXP = Math.floor(Date.now() / 1000) + 7 * 86400;

async function seed(content: unknown): Promise<void> {
  await writeFile(join(dir, 'seed.json'), JSON.stringify(content));
}

async function store(): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-codex-import-'));
  script = buildCodexImportScript({
    agentId: 'pi',
    storePath: join(dir, 'store.json'),
    providerKey: 'openai-codex',
    marker: join(dir, 'marker'),
    seedPath: join(dir, 'seed.json'),
  });
  // A store that already holds another provider — the merge case.
  await writeFile(join(dir, 'store.json'), JSON.stringify({ anthropic: { key: 'KEEP_ME' } }));
  await seed({
    auth_mode: 'chatgpt',
    tokens: { access_token: jwt(EXP), refresh_token: 'R1', account_id: 'acct_1' },
  });
});

describe('the Codex import ingest', () => {
  it('maps the login into the consumer`s own provider key', async () => {
    const { stdout } = await run('bash', ['-c', script]);
    expect(stdout).toContain('imported the Codex login as openai-codex');
    expect((await store())['openai-codex']).toEqual({
      type: 'oauth',
      access: jwt(EXP),
      refresh: 'R1',
      accountId: 'acct_1',
      // NOT 0 and not in the past: the consumer's refresh cannot renew a
      // codex-issued token, so a wrong expiry is auth that never worked.
      expires: EXP * 1000,
    });
  });

  it('MERGES one key, leaving other providers alone', async () => {
    await run('bash', ['-c', script]);
    expect((await store())['anthropic']).toEqual({ key: 'KEEP_ME' });
  });

  it('is a no-op on the second run, and re-imports a re-pushed login', async () => {
    await run('bash', ['-c', script]);
    const again = await run('bash', ['-c', script]);
    expect(again.stdout).toContain('already imported');

    // The fan-out re-pushes the host's refreshed login; the gate is a hash of
    // the SEED, so that must import again. This is the ONLY renewal path a
    // seeded box has.
    await seed({
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt(EXP + 600), refresh_token: 'R2', account_id: 'acct_1' },
    });
    const third = await run('bash', ['-c', script]);
    expect(third.stdout).toContain('imported the Codex login');
    expect((await store())['openai-codex']?.['refresh']).toBe('R2');
  });

  it('exits 0 and says so for every "nothing to ingest"', async () => {
    // A box whose model auth cannot be seeded must still come up.
    for (const bad of [undefined, { OPENAI_API_KEY: 'sk-x' }, { tokens: {} }]) {
      if (bad === undefined) {
        await writeFile(join(dir, 'seed.json'), 'not json at all');
      } else {
        await seed(bad);
      }
      const { stdout } = await run('bash', ['-c', script]);
      expect(stdout).toContain('not a usable Codex ChatGPT login');
    }
    // And the store is untouched by any of them.
    expect(await store()).toEqual({ anthropic: { key: 'KEEP_ME' } });
  });

  it('reports a missing seed by path rather than failing', async () => {
    const missing = buildCodexImportScript({
      agentId: 'opencode',
      storePath: join(dir, 'store.json'),
      providerKey: 'openai',
      marker: join(dir, 'marker2'),
      seedPath: join(dir, 'nope.json'),
    });
    const { stdout } = await run('bash', ['-c', missing]);
    expect(stdout).toContain('no borrowed Codex login at');
    expect(stdout).toContain('nope.json');
  });
});
