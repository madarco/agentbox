import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { UserFacingError } from '@agentbox/core';
import { printCliError } from '../src/lib/print-cli-error.js';

function makeSink(): { sink: Writable; readAll(): string } {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { sink, readAll: () => Buffer.concat(chunks).toString('utf8') };
}

describe('printCliError', () => {
  it('prints UserFacingError as a clean message with no stack frames', () => {
    const { sink, readAll } = makeSink();
    printCliError(new UserFacingError('no E2B base template found.\nRun `agentbox prepare`.'), sink);
    const out = readAll();
    expect(out).toBe('no E2B base template found.\nRun `agentbox prepare`.\n');
    expect(out).not.toContain(' at ');
  });

  it('also picks up the name marker even if the class identity differs', () => {
    const err = new Error('marker check');
    err.name = 'UserFacingError';
    const { sink, readAll } = makeSink();
    printCliError(err, sink);
    expect(readAll()).toBe('marker check\n');
  });

  it('prints the stack for unexpected errors so real bugs stay debuggable', () => {
    const { sink, readAll } = makeSink();
    printCliError(new Error('boom'), sink);
    const out = readAll();
    expect(out).toContain('boom');
    expect(out).toContain(' at ');
  });

  it('handles non-Error throws by stringifying them', () => {
    const { sink, readAll } = makeSink();
    printCliError('plain string failure', sink);
    expect(readAll()).toBe('plain string failure\n');
  });
});
