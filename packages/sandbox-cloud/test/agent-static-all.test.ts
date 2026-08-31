import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { stageAllAgentStatic } from '../src/sync/agent-static-all.js';

/**
 * Moved here with the dispatch. It reads the `AgentCloudModule` registry now,
 * which lives in this package — `sandbox-core` cannot see it, which is exactly
 * why the dispatch could not stay there once the per-agent stagers moved into
 * their own packages.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

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
