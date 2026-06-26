import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { uploadToCloudBox } from '../src/cloud-cp.js';
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
  await uploadToCloudBox(backend, handle, src, boxDst);
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
