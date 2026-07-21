import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postRpc, postRpcAndExit } from '../src/relay-rpc.js';
import { writeRelayEnvFile } from '../src/relay-env.js';

describe('postRpc env handling', () => {
  let prevUrl: string | undefined;
  let prevToken: string | undefined;
  let prevEnvFile: string | undefined;
  let dir: string;
  // No explicit type: vitest's spyOn return type collides with WriteStream's
  // overloaded `write` signature, and the inferred type is fine for the
  // `mock.calls` access we actually use.
  let stderrSpy = vi.spyOn(process.stderr, 'write');

  beforeEach(() => {
    prevUrl = process.env.AGENTBOX_RELAY_URL;
    prevToken = process.env.AGENTBOX_RELAY_TOKEN;
    prevEnvFile = process.env.AGENTBOX_RELAY_ENV_FILE;
    delete process.env.AGENTBOX_RELAY_URL;
    delete process.env.AGENTBOX_RELAY_TOKEN;
    // Point the relay-env file at a fresh temp dir so the env-missing cases
    // don't accidentally read a real /run/agentbox/relay.env on the host.
    dir = mkdtempSync(join(tmpdir(), 'agentbox-relay-rpc-'));
    process.env.AGENTBOX_RELAY_ENV_FILE = join(dir, 'relay.env');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.AGENTBOX_RELAY_URL;
    else process.env.AGENTBOX_RELAY_URL = prevUrl;
    if (prevToken === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
    else process.env.AGENTBOX_RELAY_TOKEN = prevToken;
    if (prevEnvFile === undefined) delete process.env.AGENTBOX_RELAY_ENV_FILE;
    else process.env.AGENTBOX_RELAY_ENV_FILE = prevEnvFile;
    rmSync(dir, { recursive: true, force: true });
    stderrSpy.mockRestore();
  });

  it('returns internalExitCode 65 + emits error when env and file are missing', async () => {
    const out = await postRpc('git.push', { path: '/workspace' });
    expect(out.internalExitCode).toBe(65);
    expect(stderrSpy).toHaveBeenCalled();
    const msg = String((stderrSpy.mock.calls[0] ?? [])[0] ?? '');
    expect(msg).toMatch(/AGENTBOX_RELAY_URL/);
  });

  it('falls back to the relay-env file when env is unset (no 65 short-circuit)', async () => {
    // Unparseable URL in the file proves resolution reached the file: postRpc
    // gets past the env check and fails at URL parsing instead of "not set".
    writeRelayEnvFile('::not-a-url', 'file-tok');
    const out = await postRpc('git.push', { path: '/workspace' });
    expect(out.internalExitCode).toBe(65);
    const msg = String((stderrSpy.mock.calls[0] ?? [])[0] ?? '');
    expect(msg).toMatch(/invalid AGENTBOX_RELAY_URL/);
  });

  it('returns internalExitCode 65 when AGENTBOX_RELAY_URL is unparseable', async () => {
    process.env.AGENTBOX_RELAY_URL = '::not-a-url';
    process.env.AGENTBOX_RELAY_TOKEN = 'tok';
    const out = await postRpc('git.push', { path: '/workspace' });
    expect(out.internalExitCode).toBe(65);
  });

  it('uses custom errorPrefix when provided', async () => {
    await postRpc('git.push', {}, { errorPrefix: 'my-prefix' });
    const msg = String((stderrSpy.mock.calls[0] ?? [])[0] ?? '');
    expect(msg).toMatch(/^my-prefix/);
  });

  it('postRpcAndExit returns the same internalExitCode on env error', async () => {
    const code = await postRpcAndExit('git.push', { path: '/workspace' });
    expect(code).toBe(65);
  });
});

/**
 * End-to-end RPC round trip: spawn a tiny in-process node:http server,
 * point AGENTBOX_RELAY_URL at it, assert postRpcAndExit forwards the
 * stdout/stderr and returns the exit code from the parsed result.
 */
describe('agentbox-ctl git pr * wire shape', () => {
  it('postRpc body matches { method: "gh.pr.create", params: { path, args } }', async () => {
    const { createServer } = await import('node:http');
    let receivedBody = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        receivedBody = body;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const prevUrl = process.env.AGENTBOX_RELAY_URL;
    const prevTok = process.env.AGENTBOX_RELAY_TOKEN;
    process.env.AGENTBOX_RELAY_URL = `http://127.0.0.1:${String(port)}`;
    process.env.AGENTBOX_RELAY_TOKEN = 'stub';
    try {
      await postRpc(
        'gh.pr.create',
        { path: '/workspace', args: ['--title', 'T', '--body', 'B'] },
        { errorPrefix: 'agentbox-ctl git pr' },
      );
      const parsed = JSON.parse(receivedBody) as { method: string; params: unknown };
      expect(parsed.method).toBe('gh.pr.create');
      expect(parsed.params).toEqual({
        path: '/workspace',
        args: ['--title', 'T', '--body', 'B'],
      });
    } finally {
      if (prevUrl === undefined) delete process.env.AGENTBOX_RELAY_URL;
      else process.env.AGENTBOX_RELAY_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
      else process.env.AGENTBOX_RELAY_TOKEN = prevTok;
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});

describe('postRpc end-to-end (in-process relay stub)', () => {
  it('forwards stdout/stderr and returns the parsed exitCode', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { method: string };
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            exitCode: 10,
            stdout: `hi from ${parsed.method}\n`,
            stderr: 'oh no\n',
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const prevUrl = process.env.AGENTBOX_RELAY_URL;
    const prevTok = process.env.AGENTBOX_RELAY_TOKEN;
    process.env.AGENTBOX_RELAY_URL = `http://127.0.0.1:${String(port)}`;
    process.env.AGENTBOX_RELAY_TOKEN = 'stub';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await postRpcAndExit('git.push', { path: '/workspace' });
      expect(code).toBe(10);
      const stdoutWrites = outSpy.mock.calls.map((c) => String(c[0] ?? '')).join('');
      const stderrWrites = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('');
      expect(stdoutWrites).toContain('hi from git.push');
      expect(stderrWrites).toContain('oh no');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (prevUrl === undefined) delete process.env.AGENTBOX_RELAY_URL;
      else process.env.AGENTBOX_RELAY_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
      else process.env.AGENTBOX_RELAY_TOKEN = prevTok;
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});
