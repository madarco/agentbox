import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { downloadFromCloudBox, uploadToCloudBox } from '../src/cloud-cp.js';
import { makeMockCloudBackend } from '../src/mock-backend.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'cloud-cp-'));
});

/** The bash one-liner handed to backend.exec lives at args[1] of the exec call. */
async function uploadAndGetCmd(boxDst: string): Promise<string> {
  const src = join(workspace, 'rollout.jsonl');
  await writeFile(src, '{}');
  const backend = makeMockCloudBackend();
  const handle = await backend.provision({ name: 'b', image: 'i' });
  await uploadToCloudBox(backend, handle, [src], boxDst);
  const execCall = backend.calls.find((c) => c.method === 'exec');
  return String(execCall!.args[1]);
}

describe('uploadToCloudBox parent-chain chown', () => {
  it('chowns the landed path, and walks parents only strictly under $HOME', async () => {
    const cmd = await uploadAndGetCmd('/home/vscode/.codex/sessions/2026/06/26/');
    expect(cmd).toContain('chown -R "$(id -un):$(id -gn)" "$final"');
    // The walk is guarded by a case on the FINAL path: strictly under home
    // only (never `/home/vscode` itself, whose dirname would be `/home`).
    expect(cmd).toContain('case "$final" in /home/vscode/*)');
    expect(cmd).toContain('while [ "$p" != /home/vscode ]');
  });
});

/**
 * A stand-in box on THIS machine: uploadFile/downloadFile copy, exec runs the
 * generated script for real. What the script does to files is the point.
 */
function localBackend() {
  return {
    name: 'local',
    uploadFile: async (_h: unknown, local: string, remote: string) => {
      await copyFile(local, remote);
    },
    downloadFile: async (_h: unknown, remote: string, local: string) => {
      await copyFile(remote, local);
    },
    exec: async (_h: unknown, cmd: string) => {
      const r = await execa('bash', ['-c', cmd], { reject: false });
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  } as unknown as CloudBackend;
}

describe('cloud cp never touches a file beside the destination (Hetzner sign-off of #426)', () => {
  it('`cp fromHost ./README.md .` from a subfolder lands in the subfolder and keeps the box README', async () => {
    const box = join(workspace, 'box');
    await mkdir(join(box, 's7'), { recursive: true });
    await writeFile(join(box, 'README.md'), "the box's own README");
    await writeFile(join(box, '.env'), 'SECRET=box');
    const pc = join(workspace, 'pc');
    await mkdir(pc);
    await writeFile(join(pc, 'README.md'), "the PC's README");
    // The destination exactly as the old ctl sent it: `.` resolved, no slash.
    const r = await uploadToCloudBox(
      localBackend(),
      {} as CloudHandle,
      [join(pc, 'README.md')],
      join(box, 's7'),
    );
    expect(r.finalPath).toBe(join(box, 's7', 'README.md'));
    expect(await readFile(join(box, 's7', 'README.md'), 'utf8')).toBe("the PC's README");
    expect(await readFile(join(box, 'README.md'), 'utf8')).toBe("the box's own README");
    expect(await readFile(join(box, '.env'), 'utf8')).toBe('SECRET=box');
  });

  it('a rename upload does not clobber a file of the source name next to the target', async () => {
    const box = join(workspace, 'box2');
    await mkdir(box, { recursive: true });
    await writeFile(join(box, 'data.csv'), 'keep me');
    const src = join(workspace, 'data.csv');
    await writeFile(src, 'incoming');
    await uploadToCloudBox(localBackend(), {} as CloudHandle, [src], join(box, 'renamed.csv'));
    expect(await readFile(join(box, 'renamed.csv'), 'utf8')).toBe('incoming');
    expect(await readFile(join(box, 'data.csv'), 'utf8')).toBe('keep me');
  });

  it('a rename download does not clobber a host file of the source name', async () => {
    const box = join(workspace, 'box3');
    await mkdir(box, { recursive: true });
    await writeFile(join(box, 'out.txt'), 'from the box');
    const host = join(workspace, 'host3');
    await mkdir(host);
    await writeFile(join(host, 'out.txt'), 'host file to keep');
    await downloadFromCloudBox(
      localBackend(),
      {} as CloudHandle,
      [join(box, 'out.txt')],
      join(host, 'copy.txt'),
    );
    expect(await readFile(join(host, 'copy.txt'), 'utf8')).toBe('from the box');
    expect(await readFile(join(host, 'out.txt'), 'utf8')).toBe('host file to keep');
  });
});

describe('cloud cp multi-source', () => {
  it('uploads each source under the dest dir (one extract per source)', async () => {
    const a = join(workspace, 'a.txt');
    const b = join(workspace, 'b.txt');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    const r = await uploadToCloudBox(backend, handle, [a, b], '/workspace/dest/');
    expect(r.finalPath).toBe('/workspace/dest/');
    // One staged upload + one extract exec per source (serial loop).
    expect(backend.calls.filter((c) => c.method === 'uploadFile')).toHaveLength(2);
    expect(backend.calls.filter((c) => c.method === 'exec')).toHaveLength(2);
  });

  it('rejects multiple upload sources when the dest is not a directory', async () => {
    const a = join(workspace, 'a.txt');
    const b = join(workspace, 'b.txt');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    await expect(uploadToCloudBox(backend, handle, [a, b], '/workspace/dest')).rejects.toThrow(
      /destination is not a directory/,
    );
  });

  it('rejects multiple download sources when the host dest is not a directory', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    const dst = join(workspace, 'not-a-dir.txt');
    await writeFile(dst, 'x');
    await expect(
      downloadFromCloudBox(backend, handle, ['/workspace/a', '/workspace/b'], dst),
    ).rejects.toThrow(/destination is not a directory/);
  });
});
