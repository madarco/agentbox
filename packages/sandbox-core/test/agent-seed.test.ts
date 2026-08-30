import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SEED_MARKER,
  AGENT_SYNC_SPECS,
  agentSeedPlacements,
  buildAgentSeedScript,
  parseSeedMarkers,
  planAgentSeeds,
} from '../src/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

const withSeeds = AGENT_SYNC_SPECS.filter((s) => (s.seeds ?? []).length > 0);

describe('AgentSyncSpec.seeds — shape', () => {
  it('every agent that reports activity via a plugin declares a seed to place it', () => {
    // The invariant the OpenCode cloud bug violated: declaring `plugin` means
    // the plugin file IS the reporting mechanism, so an agent declaring it
    // without declaring how the file gets into the box can never report at all.
    for (const spec of AGENT_SYNC_SPECS) {
      if (!spec.caps.activitySource.includes('plugin')) continue;
      expect((spec.seeds ?? []).length, `${spec.id} declares no seeds`).toBeGreaterThan(0);
    }
  });

  it('declares absolute sources, relative destinations, and no traversal', () => {
    for (const spec of withSeeds) {
      for (const seed of spec.seeds ?? []) {
        expect(seed.bakedPath.startsWith('/'), `${spec.id}: bakedPath must be absolute`).toBe(true);
        expect(seed.destRel.startsWith('/'), `${spec.id}: destRel must be relative`).toBe(false);
        expect(seed.destRel.split('/')).not.toContain('..');
        expect(seed.sharedAsset.length).toBeGreaterThan(0);
        expect(seed.sharedAsset).not.toContain('/');
        expect(seed.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('AgentSyncSpec.seeds — both sources actually carry the file', () => {
  it('bakes every declared bakedPath into the docker image', () => {
    // The primary source. A seed whose asset the image never carries would fall
    // through to the (slower, host-dependent) upload path on every single box.
    const dockerfile = read('packages/sandbox-docker/Dockerfile.box');
    for (const spec of withSeeds) {
      for (const seed of spec.seeds ?? []) {
        expect(dockerfile, `${spec.id}: ${seed.bakedPath} is not COPYed`).toContain(seed.bakedPath);
      }
    }
  });

  it('stages every declared sharedAsset under runtime/_shared', () => {
    // The fallback source, and the one that makes this fix reach snapshots baked
    // before the asset existed. An unstaged basename means the cloud path
    // silently cannot seed on any box whose base predates the asset.
    const staging = read('apps/cli/scripts/stage-runtime.mjs');
    const shared = staging.slice(staging.indexOf('const sharedFiles = ['));
    const block = shared.slice(0, shared.indexOf('];'));
    for (const spec of withSeeds) {
      for (const seed of spec.seeds ?? []) {
        expect(block, `${spec.id}: ${seed.sharedAsset} is not staged into _shared`).toContain(
          `'${seed.sharedAsset}'`,
        );
      }
    }
  });
});

describe('planAgentSeeds — docker and cloud place the same files', () => {
  it('differs only in root, never in what lands where', () => {
    // The `boxRunEnv` lesson: two transports reading one declaration must be
    // asserted equal, key for key, or they drift silently — which is exactly how
    // the cloud path ended up seeding nothing at all.
    for (const spec of withSeeds) {
      const boxDir = spec.staticPaths[0]!.boxDir;
      const dockerPlan = planAgentSeeds(spec.seeds ?? [], '/dst');
      const cloudPlan = planAgentSeeds(spec.seeds ?? [], boxDir);
      expect(dockerPlan.map((p) => p.destRel)).toEqual(cloudPlan.map((p) => p.destRel));
      expect(dockerPlan.map((p) => p.src)).toEqual(cloudPlan.map((p) => p.src));
      expect(dockerPlan.map((p) => p.dest)).toEqual(
        cloudPlan.map((p) => p.dest.replace(boxDir, '/dst')),
      );
      expect(dockerPlan.map((p) => p.ancestors)).toEqual(
        cloudPlan.map((p) => p.ancestors.map((a) => a.replace(boxDir, '/dst'))),
      );
    }
  });

  it('lists every intermediate dir, not just the immediate parent', () => {
    // A root-run `mkdir -p a/b/c` leaves the intermediates root-owned and the
    // later static-config stage then cannot write into them — a trap that cost a
    // live DigitalOcean bake. Each ancestor has to be chown-able individually.
    const [placement] = planAgentSeeds(
      [{ bakedPath: '/src/x', destRel: 'a/b/c.json', sharedAsset: 'x', label: 'x' }],
      '/dst',
    );
    expect(placement!.ancestors).toEqual(['/dst/a', '/dst/a/b']);
    expect(placement!.dest).toBe('/dst/a/b/c.json');
  });

  it('resolves an agent against its real config dir by default', () => {
    for (const spec of withSeeds) {
      const boxDir = spec.staticPaths[0]!.boxDir;
      for (const p of agentSeedPlacements(spec.id)) {
        expect(p.dest.startsWith(`${boxDir}/`)).toBe(true);
      }
    }
  });
});

describe('buildAgentSeedScript', () => {
  const seed = {
    bakedPath: '/img/hooks.json',
    destRel: 'hooks.json',
    sharedAsset: 'h',
    label: 'h',
  };

  it('never fails the caller when the baked asset is missing', () => {
    // Seeding is best-effort by design: a box whose image predates the asset
    // must still create. Both the existence guard and the `|| true` matter.
    const script = buildAgentSeedScript(planAgentSeeds([seed], '/dst'));
    expect(script).toContain("[ -f '/img/hooks.json' ]");
    expect(script.trimEnd().endsWith('|| true')).toBe(true);
  });

  it('emits chowns only when an owner is given, and by name', () => {
    const plan = planAgentSeeds([{ ...seed, destRel: 'config/plugins/p.js' }], '/dst');
    expect(buildAgentSeedScript(plan)).not.toContain('chown');
    const owned = buildAgentSeedScript(plan, { owner: 'vscode:vscode' });
    // By NAME: the box user's uid is 1000 on docker/hetzner but 1001 on vercel
    // and 1002 on e2b, so a numeric chown is wrong on two providers.
    expect(owned).toContain("chown vscode:vscode '/dst/config'");
    expect(owned).toContain("chown vscode:vscode '/dst/config/plugins'");
    expect(owned).toContain("chown vscode:vscode '/dst/config/plugins/p.js'");
    expect(owned).not.toMatch(/chown \d+:\d+/);
  });

  it('round-trips its success markers', () => {
    const script = buildAgentSeedScript(planAgentSeeds([seed], '/dst'));
    expect(script).toContain(`${AGENT_SEED_MARKER} hooks.json`);
    expect(parseSeedMarkers(`noise\n${AGENT_SEED_MARKER} hooks.json\nmore`)).toEqual([
      'hooks.json',
    ]);
    expect(parseSeedMarkers('nothing happened')).toEqual([]);
  });
});
