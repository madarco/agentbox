import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveStreamAtomically } from '../src/lib/sessions-download.js';

const dirs: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sessions-dl-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function streamOf(parts: string[], failAfter?: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (failAfter !== undefined && i === failAfter) {
        c.error(new Error('hub went away'));
        return;
      }
      if (i >= parts.length) {
        c.close();
        return;
      }
      c.enqueue(new TextEncoder().encode(parts[i++]!));
    },
  });
}

describe('saveStreamAtomically', () => {
  it('writes the whole body and reports the bytes that arrived', async () => {
    const d = dir();
    const target = join(d, 's.jsonl');
    const bytes = await saveStreamAtomically(
      streamOf(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']),
      target,
    );
    expect(bytes).toBe(24);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(readdirSync(d)).toEqual(['s.jsonl']);
  });

  it('leaves nothing truncated behind when the stream fails, and keeps an earlier complete file', async () => {
    const d = dir();
    const target = join(d, 's.jsonl');
    writeFileSync(target, 'complete earlier copy\n');
    await expect(
      saveStreamAtomically(streamOf(['{"a":1}\n', '{"b":2}\n'], 1), target),
    ).rejects.toThrow('hub went away');
    expect(readdirSync(d)).toEqual(['s.jsonl']);
    expect(readFileSync(target, 'utf8')).toBe('complete earlier copy\n');
  });

  it('creates no file at all when the first download fails', async () => {
    const d = dir();
    await expect(saveStreamAtomically(streamOf(['x'], 0), join(d, 's.jsonl'))).rejects.toThrow();
    expect(readdirSync(d)).toEqual([]);
  });
});
