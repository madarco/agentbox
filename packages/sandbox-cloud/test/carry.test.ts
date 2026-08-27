import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { uploadCarryPaths } from '../src/sync/carry.js';
import { makeMockCloudBackend } from '../src/mock-backend.js';

const HOST_HOME_REPLACE = '/home/vscode';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'cloud-carry-'));
});

function entry(over: Partial<ResolvedCarryEntry>): ResolvedCarryEntry {
  return {
    rawSrc: '~/.agentbox/x',
    rawDest: '~/.agentbox/x',
    absSrc: '',
    absDest: '~/.agentbox/x',
    kind: 'file',
    bytes: 1,
    optional: false,
    ...over,
  };
}

describe('uploadCarryPaths', () => {
  it('no-ops on empty entries', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    const res = await uploadCarryPaths({ backend, handle, entries: [] });
    expect(res).toEqual({ copied: 0, errors: [], applied: [] });
    expect(backend.calls.some((c) => c.method === 'uploadFile')).toBe(false);
  });

  it('skips missing-optional entries without uploading', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    const res = await uploadCarryPaths({
      backend,
      handle,
      entries: [entry({ kind: 'missing', absSrc: '/no/such', optional: true })],
    });
    expect(res.copied).toBe(0);
    expect(res.errors).toEqual([]);
    expect(backend.calls.filter((c) => c.method === 'uploadFile')).toHaveLength(0);
  });

  it('uploads one file + execs a single mkdir/extract/chown command', async () => {
    const src = join(workspace, 'marker.txt');
    await writeFile(src, 'hello');

    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });

    const res = await uploadCarryPaths({
      backend,
      handle,
      entries: [
        entry({
          rawSrc: '~/.agentbox/marker.txt',
          rawDest: '~/.agentbox/marker.txt',
          absSrc: src,
          absDest: '~/.agentbox/marker.txt',
          kind: 'file',
          bytes: 5,
          mode: 0o600,
        }),
      ],
    });

    expect(res.copied).toBe(1);
    expect(res.errors).toEqual([]);
    expect(res.applied).toEqual([{ src, dest: '~/.agentbox/marker.txt', bytes: 5 }]);

    // Should have uploaded exactly one tar and run exactly one exec
    // (the bash one-liner that does mkdir + tar -x + chmod + chown + rm).
    const uploadCalls = backend.calls.filter((c) => c.method === 'uploadFile');
    expect(uploadCalls).toHaveLength(1);
    const execCalls = backend.calls.filter((c) => c.method === 'exec');
    expect(execCalls).toHaveLength(1);

    const cmd = String(execCalls[0]!.args[1]);
    // ~/ expanded to /home/vscode at the host layer before being shell-quoted.
    expect(cmd).toContain(`mkdir -p '${HOST_HOME_REPLACE}/.agentbox'`);
    expect(cmd).toContain(`tar -xf /tmp/agentbox-carry-0.tar -C '${HOST_HOME_REPLACE}/.agentbox'`);
    expect(cmd).toContain(`chmod -R 0600 '${HOST_HOME_REPLACE}/.agentbox/marker.txt'`);
    expect(cmd).toContain(
      `chown -R --reference=/home/vscode '${HOST_HOME_REPLACE}/.agentbox/marker.txt'`,
    );
    expect(cmd).toContain('rm -f /tmp/agentbox-carry-0.tar');
    // Regression guard: `vscode` is not uid 1000 on vercel/e2b, so no numeric
    // owner may appear in the default command.
    expect(cmd).not.toContain('1000:1000');
  });

  // The vercel constraint: its exec wraps non-root commands in an extra
  // `bash -lc`, which mangles `$(...)`/`$var`/`while` and hangs the create.
  // Even the busiest entry shape must stay ONE exec, and the only shell
  // substitution allowed is the pre-existing parent-chain walk.
  it('keeps the busiest entry shape (mode + rename + parent chain) to a single exec', async () => {
    const src = join(workspace, 'src.txt');
    await writeFile(src, 'x');

    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });

    await uploadCarryPaths({
      backend,
      handle,
      entries: [
        entry({ absSrc: src, absDest: '~/.ssh/id_ed25519', kind: 'file', bytes: 1, mode: 0o600 }),
      ],
    });

    const execCalls = backend.calls.filter((c) => c.method === 'exec');
    expect(execCalls).toHaveLength(1);
    const cmd = String(execCalls[0]!.args[1]);
    expect(cmd).toContain('mv ');
    expect(cmd).toContain('chmod -R 0600');
    expect(cmd).toContain('[ "$parent" != "/home/vscode" ]');
    // The leaf chown and the parent-chain chown must name the SAME owner —
    // a drift there leaves the file readable but its directory not.
    expect(cmd).toContain('chown -R --reference=/home/vscode');
    expect(cmd).toContain('chown --reference=/home/vscode "$parent"');
    // `$(dirname ...)` in the parent walk is the only substitution; the owner
    // token itself must contribute none.
    expect(cmd.match(/\$\(/g) ?? []).toHaveLength(2); // parent= and parent=$(dirname "$parent")
  });

  it('walks parent dirs under $HOME and chowns them — but not outside $HOME', async () => {
    const src = join(workspace, 'm.txt');
    await writeFile(src, 'x');

    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });

    // Dest under $HOME → parent walk emitted.
    await uploadCarryPaths({
      backend,
      handle,
      entries: [
        entry({
          absSrc: src,
          absDest: '~/.agentbox/claude-credentials.json',
          kind: 'file',
          bytes: 1,
        }),
      ],
    });
    const homeCmd = String(backend.calls.filter((c) => c.method === 'exec')[0]!.args[1]);
    expect(homeCmd).toContain('[ "$parent" != "/home/vscode" ]');
    // Braced: the walk must be ONE command in the `&&` chain, so a failed
    // earlier step can't drop into the loop with `$parent` unset.
    expect(homeCmd).toContain('{ parent=$(dirname ');

    // Dest outside $HOME → no parent walk (system paths untouched).
    backend.clearCalls();
    await uploadCarryPaths({
      backend,
      handle,
      entries: [entry({ absSrc: src, absDest: '/etc/agentbox/x', kind: 'file', bytes: 1 })],
    });
    const sysCmd = String(backend.calls.filter((c) => c.method === 'exec')[0]!.args[1]);
    expect(sysCmd).not.toContain('while [ -n "$parent"');
  });

  it('honors explicit user: override (default is the box user; explicit is literal)', async () => {
    const src = join(workspace, 'm.txt');
    await writeFile(src, 'x');

    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });

    await uploadCarryPaths({
      backend,
      handle,
      entries: [
        entry({ absSrc: src, absDest: '/etc/agentbox/x', kind: 'file', bytes: 1, user: 33 }),
      ],
    });
    const cmd1 = String(backend.calls.filter((c) => c.method === 'exec')[0]!.args[1]);
    expect(cmd1).toContain('chown -R 33:33');

    // user: 0 → chown to root explicitly (NOT a skip — the result must be
    // predictable across providers, especially docker where `docker cp`
    // would otherwise leak the host's uid:gid into the box).
    backend.clearCalls();
    await uploadCarryPaths({
      backend,
      handle,
      entries: [entry({ absSrc: src, absDest: '/etc/x', kind: 'file', bytes: 1, user: 0 })],
    });
    const cmd2 = String(backend.calls.filter((c) => c.method === 'exec')[0]!.args[1]);
    expect(cmd2).toContain('chown -R 0:0');
    expect(cmd2).not.toContain('--reference');
  });

  it('per-entry isolation: a tar-pack failure on entry 0 still uploads entry 1', async () => {
    const okSrc = join(workspace, 'ok.txt');
    await writeFile(okSrc, 'ok');

    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });

    const res = await uploadCarryPaths({
      backend,
      handle,
      entries: [
        entry({ absSrc: '/no/such/host/path', absDest: '/dst/bad', kind: 'file' }),
        entry({ absSrc: okSrc, absDest: '/dst/ok', kind: 'file', bytes: 2 }),
      ],
    });

    expect(res.copied).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/tar pack failed/);
  });

  it('runs the extract as root when the backend declares stageFilesAsRoot', async () => {
    const src = join(workspace, 'marker.txt');
    await writeFile(src, 'hi');
    const backend = makeMockCloudBackend({ name: 'vercel', stageFilesAsRoot: true });
    const handle = await backend.provision({ name: 'b', image: 'i' });
    await uploadCarryPaths({
      backend,
      handle,
      entries: [entry({ absSrc: src, absDest: '~/.agentbox/marker.txt', kind: 'file', bytes: 2 })],
    });
    const execCall = backend.calls.find((c) => c.method === 'exec');
    expect(execCall!.args[2]).toMatchObject({ user: 'root' });
  });

  it('leaves the exec user unset when the backend does not declare stageFilesAsRoot', async () => {
    const src = join(workspace, 'marker.txt');
    await writeFile(src, 'hi');
    const backend = makeMockCloudBackend({ name: 'hetzner' });
    const handle = await backend.provision({ name: 'b', image: 'i' });
    await uploadCarryPaths({
      backend,
      handle,
      entries: [entry({ absSrc: src, absDest: '~/.agentbox/marker.txt', kind: 'file', bytes: 2 })],
    });
    const execCall = backend.calls.find((c) => c.method === 'exec');
    expect(execCall!.args[2]).toBeUndefined();
  });
});
