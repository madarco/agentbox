// Real skill tarballs for tests: imports verify that a body unpacks to the
// tree hash it names, so a fixture can't be an arbitrary string any more.
import { Readable } from 'node:stream';
import { treeHash, writeTar } from '@agentbox/sandbox-core';

const byKey = new Map<string, { sha: string; tar: Buffer }>();
const keyOfSha = new Map<string, string>();

/** A one-file skill whose SKILL.md body is `key`: its tree hash and gzipped tar. */
export function skillTar(key: string): { sha: string; tar: Buffer } {
  let hit = byKey.get(key);
  if (!hit) {
    const files = [
      {
        path: 'SKILL.md',
        mode: 0o644,
        data: Buffer.from(`---\nname: s\ndescription: d\n---\n${key}\n`),
      },
    ];
    hit = { sha: treeHash(files), tar: writeTar(files) };
    byKey.set(key, hit);
    keyOfSha.set(hit.sha, key);
  }
  return hit;
}

/** The version id for fixture `c` (case-insensitive, so `sha('a')` pairs with `body('A')`). */
export const fixtureSha = (c: string): string => skillTar(c.toLowerCase()).sha;

/** The tarball body for fixture `t`: a key (`'a'`, `'tar-a'`, `'A'`) or a `fixtureSha` value. */
export function fixtureBody(t: string): Readable {
  const key = keyOfSha.get(t) ?? t.replace(/^tar-/, '').toLowerCase();
  return Readable.from([skillTar(key).tar]);
}
