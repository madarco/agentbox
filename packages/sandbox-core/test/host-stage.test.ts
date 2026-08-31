import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  stageAgentStaticForUpload,
  stageAllAgentStatic,
  stageOpencodeStaticForUpload,
} from '../src/sync/host-stage.js';
import { AGENT_SYNC_SPECS } from '../src/sync/registry.js';

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

async function writeFileAt(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
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

        const res = await stageOpencodeStaticForUpload({ hostHome: home });
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
});

describe('stageAllAgentStatic', () => {
  it(
    'covers every registered agent, so a new one reaches the cloud snapshots',
    async () => {
      // Scoped to the demo agent against an empty fixture home: the real
      // claude/codex stagers would rsync the developer's own `~/.claude`, which
      // is neither cheap nor deterministic. What matters here is the DISPATCH —
      // that the set comes from the registry, not from a hardcoded triple.
      const home = await mkdtemp(join(tmpdir(), 'agentbox-stage-test-'));
      const stages = await stageAllAgentStatic({ agents: ['example'], hostHome: home });
      try {
        expect(stages.map((s) => s.kind)).toEqual(['example', 'agents']);
        const example = stages.find((s) => s.kind === 'example');
        expect(example?.extractDir).toBe(
          AGENT_SYNC_SPECS.find((s) => s.id === 'example')?.staticPaths[0]?.boxDir,
        );
      } finally {
        for (const s of stages) await s.staged.cleanup();
        await rm(home, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
