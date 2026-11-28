import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readSecretFromStream } from '../src/lib/account-login.js';
import { defaultPastedMessage } from '../src/commands/credentials-manage.js';

describe('readSecretFromStream', () => {
  it('ends at EOF', async () => {
    const s = new PassThrough();
    const p = readSecretFromStream(s, { idleMs: 10_000 });
    s.end('tok-123\n');
    expect(await p).toBe('tok-123\n');
  });

  it('a pipe that never closes ends once a line has arrived and it goes quiet', async () => {
    const s = new PassThrough();
    const p = readSecretFromStream(s, { idleMs: 20 });
    s.write('tok-');
    s.write('456\n');
    expect(await p).toBe('tok-456\n');
  });

  it('a pipe that sends nothing is an error, not a hang', async () => {
    const s = new PassThrough();
    await expect(readSecretFromStream(s, { firstByteMs: 20 })).rejects.toThrow(
      /no secret on stdin/,
    );
  });
});

describe('defaultPastedMessage', () => {
  it('points a pasted default at a name, then `credentials use`', () => {
    const msg = defaultPastedMessage('claude', '--setup-token');
    expect(msg).toContain('setup token needs a name');
    expect(msg).toContain('agentbox credentials add claude/<name> --setup-token');
    expect(msg).toContain('agentbox credentials use claude/<name> --global');
  });
});
