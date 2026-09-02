import { describe, expect, it } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { boxOverlayPorts, providerBoxFilePorts } from '../src/sync/concerns/box-files.js';

const box = { id: 'b1', name: 'svc', container: 'agentbox-svc' } as unknown as BoxRecord;

function fakeProvider(onExec: (argv: string[]) => ExecResult): Provider {
  return {
    name: 'fake',
    exec: (_b: BoxRecord, argv: string[]) => Promise.resolve(onExec(argv)),
  } as unknown as Provider;
}

/** Decode the base64 payload the probe script embeds. */
function payloadOf(script: string): string {
  const m = /printf %s '([A-Za-z0-9+/=]+)'/.exec(script);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
}

describe('boxOverlayPorts.probeBoxTokens', () => {
  it('NUL-TERMINATES the path list, so the last path is actually probed', () => {
    // Regression: `paths.join('\0')` leaves the final record unterminated, and
    // `read -r -d ''` treats an unterminated tail as EOF. The last path then
    // came back as "absent in the box" and the overlay OVERWROTE a box file it
    // was supposed to keep.
    let seen = '';
    const provider = fakeProvider((argv) => {
      seen = payloadOf(argv[2] ?? '');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    return ports.probeBoxTokens(['a.txt', 'src/b.txt']).then(() => {
      expect(seen).toBe('a.txt\0src/b.txt\0');
      expect(seen.endsWith('\0')).toBe(true);
    });
  });

  it('pairs each emitted token with its path', async () => {
    const provider = fakeProvider(() => ({
      exitCode: 0,
      stdout: 'deadbeef\0a.txt\0-\0src\0',
      stderr: '',
    }));
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    const tokens = await ports.probeBoxTokens(['a.txt', 'src']);
    expect(tokens.get('a.txt')).toBe('deadbeef');
    expect(tokens.get('src')).toBe('-');
  });

  it('reads a failed probe as "nothing known", never as "nothing there"', async () => {
    const provider = fakeProvider(() => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    expect((await ports.probeBoxTokens(['a.txt'])).size).toBe(0);
  });

  it('runs the probe as root — a Vercel/E2B non-root exec re-parses and hangs', async () => {
    let user: string | undefined;
    const provider = {
      name: 'fake',
      exec: (_b: BoxRecord, _argv: string[], opts?: { user?: string }) => {
        user = opts?.user;
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    } as unknown as Provider;
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    await ports.probeBoxTokens(['a.txt']);
    expect(user).toBe('root');
  });
});
