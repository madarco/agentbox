import { mkdtemp, writeFile } from 'node:fs/promises';
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
  it('walks parent dirs up to $HOME when the dest is under /home/vscode', async () => {
    const cmd = await uploadAndGetCmd('/home/vscode/.codex/sessions/2026/06/26/');
    // The landed subtree is chowned recursively, then the parent chain.
    expect(cmd).toContain(
      `chown -R "$(id -un):$(id -gn)" /home/vscode/.codex/sessions/2026/06/26/rollout.jsonl`,
    );
    expect(cmd).toContain('while [ "$parent" != /home/vscode ]');
    expect(cmd).toContain('parent=$(dirname /home/vscode/.codex/sessions/2026/06/26/rollout.jsonl)');
  });

  it('omits the parent walk for system paths (/etc/*)', async () => {
    const cmd = await uploadAndGetCmd('/etc/agentbox/');
    expect(cmd).not.toContain('while [ "$parent"');
    expect(cmd).toContain('leave parent ownership untouched');
  });

  it('omits the parent walk for /workspace paths', async () => {
    const cmd = await uploadAndGetCmd('/workspace/sub/');
    expect(cmd).not.toContain('while [ "$parent"');
  });

  it('omits the parent walk when the dest lands exactly at $HOME (no /home chown)', async () => {
    // boxDst without trailing slash → finalPath === /home/vscode. The walk must
    // NOT run, else `dirname` would be `/home` and could reassign it.
    const cmd = await uploadAndGetCmd('/home/vscode');
    expect(cmd).not.toContain('while [ "$parent"');
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
    await expect(
      uploadToCloudBox(backend, handle, [a, b], '/workspace/dest'),
    ).rejects.toThrow(/destination is not a directory/);
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
