import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, resolveAgentSpec } from '@agentbox/sandbox-core';
import { buildOpencodeMounts } from '../src/docker-sync.js';
import { buildCloudBoxRunEnv } from '@agentbox/sandbox-cloud';

/**
 * Lives here, not in `sandbox-cloud`, because it spans both layers: it compares
 * this agent's docker mounts against the cloud env builder. `sandbox-cloud`
 * cannot import an agent (that is the cycle); an agent package can import
 * `sandbox-cloud`, so the drift test belongs on this side.
 *
 * `boxRunEnv` is the registry's single declaration of the env an agent needs
 * inside a box. It existed with ZERO consumers: docker restated its values as
 * local consts and the cloud path hardcoded its own, shorter, copy.
 *
 * They had already drifted. Cloud set `OPENCODE_CONFIG_DIR` and omitted
 * `XDG_STATE_HOME`, so a cloud box kept OpenCode's `model.json` outside the dir
 * the snapshot captures and lost the selected model across a resume — while a
 * docker box kept it. Nothing failed; the two just quietly disagreed.
 *
 * These lock both paths to the declaration, so an agent that declares run-env
 * gets it everywhere and a future divergence is a red test rather than a
 * provider-specific bug.
 */
describe('boxRunEnv is the single source for in-box agent env', () => {
  it('the cloud env carries every key each selected agent declares', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      const env = buildCloudBoxRunEnv([spec.id]);
      for (const [k, v] of Object.entries(spec.boxRunEnv)) {
        expect(env[k], `${spec.id} declares ${k}`).toBe(v);
      }
    }
  });

  it('carries NOTHING for an agent that is not in the box', () => {
    // Per agent, not the union: a claude-only box must not be told where
    // OpenCode's config lives.
    const env = buildCloudBoxRunEnv(['claude']);
    for (const k of Object.keys(resolveAgentSpec('opencode').boxRunEnv)) {
      expect(env[k], `claude-only box leaked ${k}`).toBeUndefined();
    }
  });

  it('docker and cloud agree on opencode, key for key', () => {
    // The drift this test exists to prevent, asserted directly rather than via
    // two independent literal expectations that can be updated one at a time.
    const declared = resolveAgentSpec('opencode').boxRunEnv;
    const docker = buildOpencodeMounts({ volume: 'v' }, {}).env;
    const cloud = buildCloudBoxRunEnv(['opencode']);
    for (const [k, v] of Object.entries(declared)) {
      expect(docker[k], `docker missing ${k}`).toBe(v);
      expect(cloud[k], `cloud missing ${k}`).toBe(v);
    }
    expect(Object.keys(declared).length).toBeGreaterThan(0);
  });
});
