import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, agentIds, resolveAgentSpec } from '../src/sync/registry.js';

describe('agent sync registry', () => {
  it('resolves by canonical id and by alias', () => {
    expect(resolveAgentSpec('claude').id).toBe('claude');
    expect(resolveAgentSpec('claude-code').id).toBe('claude'); // wire alias
    expect(resolveAgentSpec('codex').id).toBe('codex');
    expect(resolveAgentSpec('opencode').id).toBe('opencode');
  });

  it('throws for an unknown tool', () => {
    expect(() => resolveAgentSpec('gemini')).toThrow(/no agent sync spec/);
  });

  it('exposes the three canonical ids in registry order', () => {
    expect(agentIds()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('credential + volume data matches the known docker/cloud layout', () => {
    const claude = resolveAgentSpec('claude');
    expect(claude.dockerVolume).toBe('agentbox-claude-config');
    expect(claude.credential.boxAbsPath).toBe('/home/vscode/.claude/.credentials.json');
    expect(claude.credential.hostBackup).toBe(join(homedir(), '.agentbox', 'claude-credentials.json'));
    expect(claude.credential.cloudMountPath).toBe('/home/vscode/.agentbox-creds/claude');

    const codex = resolveAgentSpec('codex');
    expect(codex.credential.boxAbsPath).toBe('/home/vscode/.codex/auth.json');
    expect(codex.forwardedEnvKeys).toEqual(['OPENAI_API_KEY']);
  });

  it('models opencode as three XDG source dirs with reloc + newest-wins state', () => {
    const oc = resolveAgentSpec('opencode');
    expect(oc.staticPaths).toHaveLength(3);
    const [data, config, state] = oc.staticPaths as [
      (typeof oc.staticPaths)[number],
      (typeof oc.staticPaths)[number],
      (typeof oc.staticPaths)[number],
    ];
    expect(data.hostHomeRel).toEqual(['.local', 'share', 'opencode']);
    expect(data.relocToSubpath).toBeUndefined();
    expect(config.relocToSubpath).toBe('config');
    expect(state.relocToSubpath).toBe('.state/opencode');
    expect(state.update).toBe(true);
    expect(oc.boxRunEnv()).toEqual({
      OPENCODE_CONFIG_DIR: '/home/vscode/.local/share/opencode/config',
      XDG_STATE_HOME: '/home/vscode/.local/share/opencode/.state',
    });
    expect(oc.caps).toEqual({ resume: false, teleport: 'stub', activitySource: 'plugin' });
  });

  it('is the single source of truth for the static-stage excludes', () => {
    // These arrays are consumed verbatim by `host-stage.ts`'s stage producers
    // (mapped to `rsync --exclude=<pattern>`). Locking them here keeps the
    // registry authoritative — the producers no longer hold their own copies.
    expect(resolveAgentSpec('claude').staticPaths[0]?.exclude).toEqual([
      'node_modules',
      '.credentials.json',
      'projects',
      'workflows',
      'sessions',
      'history.jsonl',
      'file-history',
      'shell-snapshots',
      'backups',
      'session-env',
      'paste-cache',
      'cache',
      'telemetry',
      'tasks',
      'downloads',
      'chrome',
      'ide',
      'debug',
      'mcp-needs-auth-cache.json',
      'stats-cache.json',
    ]);
    expect(resolveAgentSpec('codex').staticPaths[0]?.exclude).toEqual([
      'auth.json',
      'sessions',
      'log',
      'history.jsonl',
      'hooks.json',
      'state_*.sqlite*',
      'logs_*.sqlite*',
      'external_agent_session_imports.json',
      'sqlite',
      'cache',
      'vendor_imports',
      'tmp',
      '/.tmp/*',
      '.tmp',
      '.codex-global-state.json',
      '.codex-global-state.json.bak',
      '.personality_migration',
      'shell_snapshots',
      'session_index.jsonl',
      'models_cache.json',
      'installation_id',
      'version.json',
      'packages',
      'plugins/.plugin-appserver',
      'computer-use',
      'archived_sessions',
    ]);
    // The `.tmp/marketplaces` carve-in: emitted before the excludes
    // (first-match-wins) so git-marketplace snapshots reach the box while the
    // rest of `.tmp` (desktop-app payloads) stays out.
    expect(resolveAgentSpec('codex').staticPaths[0]?.include).toEqual([
      '/.tmp/',
      '/.tmp/marketplaces/***',
    ]);
    // opencode data tree — auth.json ships separately, snapshot is host-only.
    expect(resolveAgentSpec('opencode').staticPaths[0]?.exclude).toEqual([
      'auth.json',
      'storage',
      'log',
      'project',
      'cache',
      'bin',
      'repos',
      'snapshot',
      'config',
      'opencode.db',
      'opencode.db-shm',
      'opencode.db-wal',
    ]);
  });

  it('every spec resolves to itself by its own id', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      expect(resolveAgentSpec(spec.id)).toBe(spec);
    }
  });
});
