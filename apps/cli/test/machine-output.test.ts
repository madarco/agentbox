import { describe, expect, it } from 'vitest';
import { withCleanStdout } from '../src/lib/machine-output.js';

/**
 * The boundary that keeps a captured value clean. The bug it fixes was real:
 * `$(agentbox agent state X)` returned the spinner's cursor-show escape glued
 * to the state word, so every string comparison against it failed.
 */

function capture<T>(fn: () => Promise<T>): Promise<{ out: string; err: string; value?: T }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: unknown) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    err += String(c);
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((value) => ({ out, err, value }))
    .finally(() => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    });
}

describe('withCleanStdout', () => {
  it('diverts stdout chrome to stderr and lets only emit through', async () => {
    const seen = await capture(() =>
      withCleanStdout(async (o) => {
        process.stdout.write('\x1b[?25h');
        process.stdout.write('starting local hub\n');
        o.emit('working\n');
      }),
    );
    expect(seen.out).toBe('working\n');
    expect(seen.err).toContain('\x1b[?25h');
    expect(seen.err).toContain('starting local hub');
  });

  it('restores stdout after the action returns', async () => {
    await withCleanStdout(async () => {});
    const seen = await capture(async () => {
      process.stdout.write('plain\n');
    });
    expect(seen.out).toBe('plain\n');
    expect(seen.err).toBe('');
  });

  it('restores stdout when the action throws', async () => {
    await expect(
      withCleanStdout(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const seen = await capture(async () => {
      process.stdout.write('plain\n');
    });
    expect(seen.out).toBe('plain\n');
  });
});
