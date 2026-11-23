import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SKILL_PROPOSAL_LIMITS, writeTar, type TarFile } from '@agentbox/sandbox-core';
import { createSkillProposals } from '../lib/backend/skill-proposals';
import { SkillsError } from '../lib/backend/skills';
import { memStore } from './_skills-mem-store';

// A pending proposal's tarball waits in the hub's memory until someone answers
// (up to a day). Before these caps one box could park 20 of up to 100 MiB each.

function skill(name: string, extra?: Buffer): Buffer {
  const files: TarFile[] = [
    {
      path: 'SKILL.md',
      mode: 0o644,
      data: Buffer.from(`---\nname: ${name}\ndescription: The ${name} skill\n---\nbody\n`),
    },
  ];
  if (extra) files.push({ path: 'blob.bin', mode: 0o644, data: extra });
  return writeTar(files);
}

/** Approvals that never get answered: every proposal stays pending. */
const never = () => new Promise<boolean>(() => {});

async function refusal(p: Promise<unknown>): Promise<SkillsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsError);
  return err as SkillsError;
}

describe('skill proposal caps', () => {
  it('ships the agreed limits', () => {
    expect(SKILL_PROPOSAL_LIMITS).toEqual({
      perBox: 3,
      total: 10,
      maxBytes: 8 * 1024 * 1024,
      totalBytes: 64 * 1024 * 1024,
    });
  });

  it('lets one box have at most 3 proposals waiting', async () => {
    const proposals = createSkillProposals({ store: memStore(), approve: never });
    const box = { id: 'b1', name: 'one' };
    for (const n of ['a', 'b', 'c']) {
      expect((await proposals.propose({ name: n, tarball: skill(n), box })).status).toBe('pending');
    }
    const err = await refusal(proposals.propose({ name: 'd', tarball: skill('d'), box }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/this box already has 3 skill proposals waiting.*max 3/);
    // Another box is not held back by this one.
    const other = { id: 'b2', name: 'two' };
    expect((await proposals.propose({ name: 'd', tarball: skill('d'), box: other })).status).toBe(
      'pending',
    );
  });

  it('caps the hub at 10 waiting proposals', async () => {
    const proposals = createSkillProposals({ store: memStore(), approve: never });
    for (let i = 0; i < 10; i++) {
      const n = `s${String(i)}`;
      await proposals.propose({
        name: n,
        tarball: skill(n),
        box: { id: `b${String(i)}`, name: n },
      });
    }
    expect(proposals.pending()).toBe(10);
    const err = await refusal(
      proposals.propose({ name: 'x', tarball: skill('x'), box: { id: 'bx', name: 'x' } }),
    );
    expect(err.message).toMatch(/10 skill proposals are already waiting.*max 10/);
  });

  it('refuses a proposal over 8 MiB, compressed or unpacked', async () => {
    const proposals = createSkillProposals({ store: memStore(), approve: never });
    const box = { id: 'b1', name: 'one' };
    // Random bytes don't compress: the tarball itself is over the cap.
    const big = await refusal(
      proposals.propose({ name: 'big', tarball: skill('big', randomBytes(9 * 1024 * 1024)), box }),
    );
    expect(big.code).toBe('invalid_request');
    expect(big.message).toMatch(/over the 8\.0 MB cap for a proposed skill/);
    // Zeros compress to almost nothing but unpack over the cap: refused too.
    await refusal(
      proposals.propose({ name: 'zip', tarball: skill('zip', Buffer.alloc(9 * 1024 * 1024)), box }),
    );
    expect(proposals.pending()).toBe(0);
  });

  it('caps the bytes every waiting proposal holds together', async () => {
    const proposals = createSkillProposals({
      store: memStore(),
      approve: never,
      maxTotalBytes: 1024 * 1024,
    });
    const blob = () => randomBytes(400 * 1024);
    await proposals.propose({
      name: 'a',
      tarball: skill('a', blob()),
      box: { id: 'b1', name: 'a' },
    });
    await proposals.propose({
      name: 'b',
      tarball: skill('b', blob()),
      box: { id: 'b2', name: 'b' },
    });
    const err = await refusal(
      proposals.propose({ name: 'c', tarball: skill('c', blob()), box: { id: 'b3', name: 'c' } }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/already hold .* \(max 1\.0 MB together\)/);
  });

  it('frees a slot once a proposal is answered', async () => {
    let answer!: (v: boolean) => void;
    const proposals = createSkillProposals({
      store: memStore(),
      approve: () => new Promise<boolean>((r) => (answer = r)),
      maxPendingPerBox: 1,
    });
    const box = { id: 'b1', name: 'one' };
    await proposals.propose({ name: 'a', tarball: skill('a'), box });
    await refusal(proposals.propose({ name: 'b', tarball: skill('b'), box }));
    answer(false);
    await new Promise((r) => setTimeout(r, 10));
    expect((await proposals.propose({ name: 'b', tarball: skill('b'), box })).status).toBe(
      'pending',
    );
  });

  it('frees the slot when asking for the approval throws', async () => {
    const proposals = createSkillProposals({
      store: memStore(),
      approve: () => {
        throw new Error('no such box in the prompt mailbox');
      },
      maxPendingPerBox: 1,
    });
    const box = { id: 'b1', name: 'one' };
    await expect(proposals.propose({ name: 'a', tarball: skill('a'), box })).rejects.toThrow(
      /no such box/,
    );
    expect(proposals.pending()).toBe(0);
  });
});
