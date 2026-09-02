import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import {
  BoxProbeError,
  boxOverlayPorts,
  chunkPathsForExec,
  providerBoxFilePorts,
} from '../src/sync/concerns/box-files.js';

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

  it('THROWS on a failed probe instead of returning an empty map', async () => {
    // Regression: the empty map read downstream as "the box has none of these
    // paths", so `overlayHostDirIntoBox` copied every host file over the box's
    // — the exact inverse of the box-wins contract, triggered by any script
    // error or rejected exec. An unreadable answer is not an empty answer.
    const provider = fakeProvider(() => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    await expect(ports.probeBoxTokens(['a.txt'])).rejects.toThrow(BoxProbeError);
    await expect(ports.probeBoxTokens(['a.txt'])).rejects.toThrow(/boom/);
  });

  it('fails the whole probe when a LATER chunk fails, not just that chunk', async () => {
    // The partial map from the successful chunks is the same data-loss shape:
    // every path in the failed chunk would read as absent in the box.
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      return calls === 1
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 2, stdout: '', stderr: 'later chunk died' };
    });
    const ports = boxOverlayPorts(providerBoxFilePorts(provider, box), '/workspace');
    const many = Array.from({ length: 4000 }, (_, i) => `dir${String(i)}/file-${String(i)}.txt`);
    await expect(ports.probeBoxTokens(many)).rejects.toThrow(/later chunk died/);
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

describe('chunkPathsForExec', () => {
  // Linux MAX_ARG_STRLEN is 128 KiB for a SINGLE argv entry, and the path list
  // rides in as one base64 `printf` argument. Without chunking, clone / cloud
  // download / non-git sync die on any workspace with a few thousand files.
  const MAX_ARG_STRLEN = 128 * 1024;

  /** Encoded size of one chunk's payload, exactly as the ports build it. */
  function encodedBytes(chunk: string[]): number {
    return Buffer.from(`${chunk.join('\0')}\0`).toString('base64').length;
  }

  it('keeps every chunk well under the single-argument limit', () => {
    // ~9000 paths of ~40 bytes = ~360 KB raw, ~480 KB base64 — nearly 4x the cap
    // as one argument.
    const paths = Array.from(
      { length: 9000 },
      (_, i) => `packages/app/src/generated/module-${String(i).padStart(6, '0')}.ts`,
    );
    const raw = Buffer.byteLength(`${paths.join('\0')}\0`);
    expect(raw).toBeGreaterThan(MAX_ARG_STRLEN * 2);

    const chunks = chunkPathsForExec(paths);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(encodedBytes(chunk)).toBeLessThan(MAX_ARG_STRLEN);
  });

  it('loses no path and preserves order', () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `f/${String(i)}.txt`);
    expect(chunkPathsForExec(paths).flat()).toEqual(paths);
  });

  it('keeps a small list as one chunk, and an empty list as none', () => {
    expect(chunkPathsForExec(['a.txt', 'b/c.txt'])).toEqual([['a.txt', 'b/c.txt']]);
    expect(chunkPathsForExec([])).toEqual([]);
  });

  it('never drops a single path that is itself over the budget', () => {
    const huge = `d/${'x'.repeat(100)}`;
    expect(chunkPathsForExec(['a.txt', huge, 'b.txt'], 50).flat()).toEqual([
      'a.txt',
      huge,
      'b.txt',
    ]);
  });
});

describe('providerBoxFilePorts.pullTar', () => {
  it('chunks the tar path list and appends after the first chunk', async () => {
    // One `tar -cf` per call would truncate the archive to the last chunk; the
    // first creates, the rest `-rf` append (REMOTE_TAR is uncompressed on purpose).
    const scripts: string[] = [];
    const provider = {
      name: 'fake',
      exec: (_b: BoxRecord, argv: string[]) => {
        scripts.push(argv[2] ?? '');
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      downloadPath: (_b: BoxRecord, _remote: string[], local: string) =>
        writeFile(local, Buffer.from('tar')),
    } as unknown as Provider;

    const paths = Array.from(
      { length: 9000 },
      (_, i) => `packages/app/src/generated/module-${String(i).padStart(6, '0')}.ts`,
    );
    await providerBoxFilePorts(provider, box).pullTar('/workspace', paths);

    const packs = scripts.filter((s) => s.includes('base64 -d | tar'));
    expect(packs.length).toBeGreaterThan(1);
    expect(packs[0]).toContain('-cf');
    for (const later of packs.slice(1)) expect(later).toContain('-rf');
    for (const s of scripts) expect(s.length).toBeLessThan(128 * 1024);
  });
});
