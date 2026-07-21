import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSETS, resolveRuntimeAssets } from '../src/runtime-assets.js';

function makeFakeRepo(): string {
  // Synth a tiny repo skeleton that has every monorepo file
  // `candidatesFor()` looks for under the source-tree fallback path.
  const root = mkdtempSync(join(tmpdir(), 'agentbox-digitalocean-test-'));
  mkdirSync(join(root, 'packages/sandbox-digitalocean/scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/ctl/dist'), { recursive: true });
  mkdirSync(join(root, 'packages/sandbox-docker/scripts'), { recursive: true });
  mkdirSync(join(root, 'apps/cli/share/agentbox-setup'), { recursive: true });
  const files = [
    'packages/sandbox-digitalocean/scripts/install-box.sh',
    'packages/ctl/dist/bin.cjs',
    'packages/sandbox-docker/scripts/agentbox-vnc-start',
    'packages/sandbox-docker/scripts/agentbox-dockerd-start',
    'packages/sandbox-docker/scripts/agentbox-portless-trust',
    'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
    'packages/sandbox-docker/scripts/agentbox-open',
    'packages/sandbox-docker/scripts/gh-shim',
    'packages/sandbox-docker/scripts/git-shim',
    'packages/sandbox-docker/scripts/ntn-shim',
    'packages/sandbox-docker/scripts/linear-shim',
    'packages/sandbox-digitalocean/scripts/custom-system-CLAUDE.md',
    'packages/sandbox-docker/scripts/claude-managed-settings.json',
    'packages/sandbox-docker/scripts/agentbox-codex-hooks.json',
    'apps/cli/share/agentbox-setup/SKILL.md',
  ];
  for (const rel of files) writeFileSync(join(root, rel), 'stub');
  // Marker so `guessRepoRoot()` (the resolver's default walk-up) can find it.
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
  return root;
}

describe('resolveRuntimeAssets', () => {
  it('resolves every asset from a monorepo source tree', () => {
    const repo = makeFakeRepo();
    const out = resolveRuntimeAssets({ repoRoot: repo });
    expect(out).toHaveLength(RUNTIME_ASSETS.length);
    for (const a of out) {
      expect(a.localPath.startsWith(repo)).toBe(true);
    }
  });

  it('lists every missing path when assets are not found', () => {
    expect(() => resolveRuntimeAssets({ repoRoot: '/nonexistent/path/that/does/not/exist' })).toThrow(
      /could not resolve runtime assets/,
    );
  });

  it('prefers cliRuntimeRoot when provided', () => {
    const repo = makeFakeRepo();
    // Fake a staged CLI runtime tree at a different location, with just
    // install-box.sh, and check the resolver picks the CLI path for that
    // entry but falls through to the repo for the rest.
    const cliRuntime = mkdtempSync(join(tmpdir(), 'agentbox-digitalocean-cli-'));
    mkdirSync(join(cliRuntime, 'digitalocean/scripts'), { recursive: true });
    writeFileSync(join(cliRuntime, 'digitalocean/scripts/install-box.sh'), 'cli-stub');
    const out = resolveRuntimeAssets({ cliRuntimeRoot: cliRuntime, repoRoot: repo });
    const installAsset = out.find((a) => a.name === 'install-box.sh');
    expect(installAsset?.localPath).toBe(join(cliRuntime, 'digitalocean/scripts/install-box.sh'));
    const ctlAsset = out.find((a) => a.name === 'agentbox-ctl');
    expect(ctlAsset?.localPath).toBe(join(repo, 'packages/ctl/dist/bin.cjs'));
  });
});
