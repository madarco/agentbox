import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  stageOpencodeCredentialsForUpload,
  stageOpencodeStateForUpload,
} from '../src/host-stage.js';

async function tarEntries(tarball: string): Promise<string[]> {
  const { stdout } = await execa('tar', ['-tzf', tarball]);
  return stdout
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((l) => l.length > 0 && l !== '.');
}

async function writeFileAt(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

/** Real `tar`; generous budget because the whole repo's suites run in parallel. */
const SUBPROCESS_TIMEOUT_MS = 30_000;

describe('opencode host staging', () => {
  it(
    'prefers the cloud credential backup over the host auth.json',
    async () => {
      // The backup is what a PREVIOUS cloud box captured; the host's real file
      // may be older or absent. Getting this order wrong ships a stale login.
      const home = await mkdtemp(join(tmpdir(), 'agentbox-oc-stage-'));
      await writeFileAt(join(home, '.agentbox', 'opencode-credentials.json'), '{"from":"backup"}');
      await writeFileAt(join(home, '.local', 'share', 'opencode', 'auth.json'), '{"from":"host"}');

      const res = await stageOpencodeCredentialsForUpload({ hostHome: home });
      expect(res.tarballPath).not.toBeNull();
      const dir = await mkdtemp(join(tmpdir(), 'agentbox-oc-extract-'));
      await execa('tar', ['-xzf', res.tarballPath as string, '-C', dir]);
      await res.cleanup();
      const { stdout } = await execa('cat', [join(dir, 'auth.json')]);
      expect(stdout).toContain('backup');
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    'falls back to the host auth.json when no backup exists',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agentbox-oc-stage-'));
      await writeFileAt(join(home, '.local', 'share', 'opencode', 'auth.json'), '{"from":"host"}');

      const res = await stageOpencodeCredentialsForUpload({ hostHome: home });
      expect(res.tarballPath).not.toBeNull();
      expect(await tarEntries(res.tarballPath as string)).toContain('auth.json');
      await res.cleanup();
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it('stages nothing when the host has no opencode credential at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-oc-stage-'));
    const res = await stageOpencodeCredentialsForUpload({ hostHome: home });
    expect(res.tarballPath).toBeNull();
    await res.cleanup();
  });

  it(
    'ships only model.json for the selected-model state',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agentbox-oc-stage-'));
      await writeFileAt(join(home, '.local', 'state', 'opencode', 'model.json'), '{"m":1}');
      // Sits beside it in the same tree and must NOT ride along.
      await writeFileAt(join(home, '.local', 'state', 'opencode', 'cwd'), '/workspace');

      const res = await stageOpencodeStateForUpload({ hostHome: home });
      expect(res.tarballPath).not.toBeNull();
      expect(await tarEntries(res.tarballPath as string)).toEqual(['model.json']);
      await res.cleanup();
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it('stages nothing when the host never picked a model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-oc-stage-'));
    const res = await stageOpencodeStateForUpload({ hostHome: home });
    expect(res.tarballPath).toBeNull();
    await res.cleanup();
  });
});
