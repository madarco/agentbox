import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  borrowIngestTask,
  borrowedCredentialCarry,
  resolveBorrowedCredentials,
  resolveHostCredentialFile,
  resolveAgentSpec,
  planPropagateTargets,
} from '../src/index.js';

const openclaw = resolveAgentSpec('openclaw');
const codex = resolveAgentSpec('codex');

describe('resolveBorrowedCredentials', () => {
  it('accepts a declared borrow, deduplicated and trimmed', () => {
    expect(resolveBorrowedCredentials(openclaw, [' codex ', 'codex'])).toEqual(['codex']);
  });

  it('is empty for nothing requested', () => {
    expect(resolveBorrowedCredentials(openclaw, undefined)).toEqual([]);
    expect(resolveBorrowedCredentials(openclaw, [''])).toEqual([]);
  });

  it('refuses an agent the row does not declare, naming what it does', () => {
    // A silently dropped entry is a box with no model auth and no message —
    // the exact failure this feature exists to end.
    expect(() => resolveBorrowedCredentials(openclaw, ['claude'])).toThrow(/declares codex/);
  });

  it('refuses on an agent with no modelAuth at all', () => {
    expect(() => resolveBorrowedCredentials(codex, ['codex'])).toThrow(/declares nothing/);
  });

  it('refuses a declared borrow whose lender has no host credential', () => {
    const spec = {
      id: 'x',
      modelAuth: { borrows: [{ agent: 'openclaw', label: 'l' }], ingestTask: 't' },
    };
    expect(() => resolveBorrowedCredentials(spec, ['openclaw'])).toThrow(/no host-side credential/);
  });
});

describe('resolveHostCredentialFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abx-borrow-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const login = (tag: string) =>
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: `rt.${tag}` } });

  it('picks the most recently written valid candidate for an agent with no freshness rule', async () => {
    // The host's own `codex` refreshes its real file; nothing copies that into
    // the backup, so "backup first" would seed a days-older refresh token.
    const backup = join(dir, 'backup.json');
    const real = join(dir, 'auth.json');
    await writeFile(backup, login('old'));
    await writeFile(real, login('new'));
    const t = Date.now() / 1000;
    await utimes(backup, t - 86400, t - 86400);
    await utimes(real, t, t);
    const got = await resolveHostCredentialFile('codex', { candidates: [backup, real] });
    expect(got?.path).toBe(real);
    expect(got?.text).toContain('rt.new');
  });

  it('skips a candidate that fails the shape gate', async () => {
    const backup = join(dir, 'backup.json');
    const real = join(dir, 'auth.json');
    await writeFile(backup, login('ok'));
    await writeFile(real, '');
    const t = Date.now() / 1000;
    await utimes(backup, t - 86400, t - 86400);
    // The newer file is empty, which fails codex's `nonempty-json` shape, so
    // the older valid one is chosen. Content (is it a ChatGPT login?) is the
    // in-box ingest task's check, not the host's.
    const got = await resolveHostCredentialFile('codex', { candidates: [backup, real] });
    expect(got?.path).toBe(backup);
    const none = await resolveHostCredentialFile('codex', {
      candidates: [join(dir, 'missing.json'), join(dir, 'empty.json')],
    });
    expect(none).toBeNull();
  });

  it('orders by the declared freshness field when the agent has one', async () => {
    const older = join(dir, 'a.json');
    const newer = join(dir, 'b.json');
    const blob = (exp: number) =>
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: exp } });
    await writeFile(older, blob(1000));
    await writeFile(newer, blob(2000));
    // mtime says the opposite of the freshness field; the field wins.
    const t = Date.now() / 1000;
    await utimes(older, t, t);
    await utimes(newer, t - 86400, t - 86400);
    const got = await resolveHostCredentialFile('claude', { candidates: [older, newer] });
    expect(got?.path).toBe(newer);
  });
});

describe('borrowedCredentialCarry', () => {
  it('reports and skips an agent the host has no login for', async () => {
    const lines: string[] = [];
    const entries = await borrowedCredentialCarry(
      ['codex'],
      (l) => lines.push(l),
      async () => null,
    );
    expect(entries).toEqual([]);
    expect(lines.join('\n')).toMatch(/no codex login on this host/);
  });
});

describe('borrowedCredentialCarry with a real file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abx-borrow-carry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces one 0600 file entry per borrowed agent', async () => {
    const path = join(dir, 'auth.json');
    await writeFile(path, '{"tokens":{"refresh_token":"x"}}');
    const entries = await borrowedCredentialCarry(['codex'], undefined, async () => ({
      path,
      text: 'unused',
    }));
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.absSrc).toBe(path);
    expect(e.absDest).toBe(codex.credential!.boxAbsPath);
    expect(e.kind).toBe('file');
    expect(e.mode).toBe(0o600);
    expect(e.optional).toBe(true);
  });
});

describe('borrowIngestTask', () => {
  it('names the task the row declares, and nothing for an agent without one', () => {
    expect(borrowIngestTask(openclaw)).toBe('openclaw-model-auth');
    expect(borrowIngestTask(codex)).toBeUndefined();
  });
});

describe('planPropagateTargets and borrowing boxes', () => {
  const boxes = [
    { id: 's', name: 'source', provider: 'docker', projectRoot: '/p', agents: ['codex'] },
    {
      id: 'b',
      name: 'bot',
      provider: 'docker',
      projectRoot: '/p',
      agents: ['openclaw'],
      borrowedCredentials: ['codex'],
    },
    { id: 'c', name: 'claude-only', provider: 'docker', projectRoot: '/p', agents: ['claude'] },
    {
      id: 'e',
      name: 'cloud-bot',
      provider: 'e2b',
      projectRoot: '/p',
      agents: ['openclaw'],
      borrowedCredentials: ['codex'],
    },
  ];

  it('lists a borrowing box separately, on any provider, and never as a volume write', () => {
    const plan = planPropagateTargets(boxes, { agent: 'codex', sourceBoxId: 's', scope: 'all' });
    expect(plan.borrowingBoxes.map((b) => b.id)).toEqual(['b', 'e']);
    // The bot mounts no codex volume, so writing the shared one would reach
    // nothing it reads.
    expect(plan.dockerVolumes).toEqual([]);
    expect(plan.cloudBoxes).toEqual([]);
  });

  it('still excludes a box that neither runs nor borrows the agent', () => {
    const plan = planPropagateTargets(boxes, { agent: 'claude', sourceBoxId: 's', scope: 'all' });
    expect(plan.borrowingBoxes).toEqual([]);
    expect(plan.dockerVolumes.flatMap((v) => v.boxNames)).toEqual(['claude-only']);
  });
});
