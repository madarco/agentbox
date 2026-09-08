import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { stageAgentStaticForUpload } from '../src/sync/host-stage.js';

/** Every path inside a staged tarball, relative and without the leading `./`. */
async function tarEntries(tarball: string): Promise<string[]> {
  const { stdout } = await execa('tar', ['-tzf', tarball]);
  return stdout
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((l) => l.length > 0 && l !== '.');
}

/**
 * These tests run real `rsync` and `tar`. The default 5s budget is enough on an
 * idle machine and not enough when the whole repo's vitest suites run in
 * parallel, which is exactly how CI runs them.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

/** sockaddr_un caps a unix socket path at 104 bytes on macOS. */
const SHORT_TMP = existsSync('/tmp') ? '/tmp' : tmpdir();

async function writeFileAt(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

/** A live unix socket at `path`, closed when the returned callback runs. */
async function unixSocketAt(path: string): Promise<() => Promise<void>> {
  await mkdir(join(path, '..'), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('stageAgentStaticForUpload', () => {
  it(
    "reproduces opencode's two-source layout from the registry row alone",
    async () => {
      // The behavior this replaced was hand-written: data at the root, config
      // relocated under `config/`, auth.json and runtime state excluded. All of
      // it is `staticPaths` data now, so this is the proof the data says enough.
      const home = await mkdtemp(join(tmpdir(), 'agentbox-stage-test-'));
      try {
        const data = join(home, '.local', 'share', 'opencode');
        await writeFileAt(join(data, 'model.json'), '{}');
        await writeFileAt(join(data, 'auth.json'), '{"secret":1}');
        await writeFileAt(join(data, 'storage', 'big.bin'), 'x');
        await writeFileAt(join(home, '.config', 'opencode', 'opencode.json'), '{}');
        // `stagedAs: 'state'` — must NOT be baked into a shared snapshot.
        await writeFileAt(join(home, '.local', 'state', 'opencode', 'cwd'), '/workspace');

        // The generic stager directly: opencode's own wrapper moved into
        // `@agentbox/agent-opencode`, and what is under test here is that the
        // registry row alone reproduces the layout.
        const res = await stageAgentStaticForUpload('opencode', { hostHome: home });
        expect(res.tarballPath).not.toBeNull();
        const entries = await tarEntries(res.tarballPath as string);
        await res.cleanup();

        expect(entries).toContain('model.json');
        expect(entries).toContain('config/opencode.json');
        // The credential ships on its own path, never in the static tarball.
        expect(entries).not.toContain('auth.json');
        // Host-only runtime state.
        expect(entries.some((e) => e.startsWith('storage'))).toBe(false);
        // The `stagedAs: 'state'` source.
        expect(entries.some((e) => e.startsWith('.state'))).toBe(false);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    'stages an agent that has only a registry row and no code here',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agentbox-stage-test-'));
      try {
        await writeFileAt(join(home, '.agentbox-example', 'settings.json'), '{"demo":true}');
        const res = await stageAgentStaticForUpload('example', { hostHome: home });
        expect(res.tarballPath).not.toBeNull();
        const entries = await tarEntries(res.tarballPath as string);
        await res.cleanup();
        expect(entries).toContain('settings.json');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    'yields nothing when the host has none of the declared sources',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agentbox-stage-test-'));
      try {
        const res = await stageAgentStaticForUpload('example', { hostHome: home });
        expect(res.tarballPath).toBeNull();
        await res.cleanup();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    'skips a unix socket in the source tree instead of aborting the stage',
    async () => {
      // Codex's desktop app leaves a live `~/.codex/ipc/ipc.sock` behind. `rsync
      // -a` implies `-D`, so it tries to recreate the socket in the stage dir —
      // and on macOS that bind() fails with EINVAL once the stage path passes
      // sockaddr_un's 104-byte limit, taking the whole bake down with exit 23.
      // Under a short root: macOS's own tmpdir() is already long enough that
      // *binding* the fixture socket would fail before rsync ever sees it. The
      // stage dir rsync writes into still comes from tmpdir(), so the failure
      // this guards against is reproduced, not sidestepped.
      const home = await mkdtemp(join(SHORT_TMP, 'ab-stage-'));
      let closeSocket: (() => Promise<void>) | null = null;
      try {
        const data = join(home, '.local', 'share', 'opencode');
        await writeFileAt(join(data, 'model.json'), '{}');
        closeSocket = await unixSocketAt(join(data, 'ipc', 'ipc.sock'));

        const res = await stageAgentStaticForUpload('opencode', { hostHome: home });
        expect(res.tarballPath).not.toBeNull();
        const entries = await tarEntries(res.tarballPath as string);
        await res.cleanup();
        expect(entries).toContain('model.json');
        expect(entries).not.toContain('ipc/ipc.sock');
      } finally {
        if (closeSocket) await closeSocket();
        await rm(home, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
