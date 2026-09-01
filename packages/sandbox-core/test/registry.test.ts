import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPushExcludes, LIVE_DATABASE_EXCLUDES } from '@agentbox/core';
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

  it('exposes the canonical ids in registry order, shipped agents first', () => {
    // `example` is the seam canary (hidden, see @agentbox/agent-example). It is
    // last so the order the three shipped agents are presented in never moves.
    expect(agentIds()).toEqual(['claude', 'codex', 'opencode', 'example']);
  });

  it('credential + volume data matches the known docker/cloud layout', () => {
    const claude = resolveAgentSpec('claude');
    expect(claude.dockerVolume).toBe('agentbox-claude-config');
    expect(claude.credential.boxAbsPath).toBe('/home/vscode/.claude/.credentials.json');
    expect(claude.credential.hostBackup).toBe(
      join(homedir(), '.agentbox', 'claude-credentials.json'),
    );
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
    expect(oc.boxRunEnv).toEqual({
      OPENCODE_CONFIG_DIR: '/home/vscode/.local/share/opencode/config',
      XDG_STATE_HOME: '/home/vscode/.local/share/opencode/.state',
    });
    expect(oc.caps.resume).toBe(false);
    expect(oc.caps.teleport).toBe('stub');
    expect(oc.caps.activitySource).toEqual(['plugin']);
    // The refusal text is data on the capability, so declaring the stub is all
    // an agent has to do — `prepareTeleport` has no per-agent branch.
    expect(oc.caps.teleportStubReason).toContain('opencode.db');
  });

  it('is the single source of truth for the push excludes', () => {
    // The producers consume `agentPushExcludes(spec, path, target)`, not the raw
    // array, so that is what this locks — it is what actually reaches rsync.
    //
    // Two entries are DERIVED rather than listed, which is the point: the
    // credential file (excluded from a shared snapshot, kept for the box's own
    // volume) and the live-database deny. Codex's `state_*.sqlite*` /
    // `logs_*.sqlite*` / `sqlite` used to be named here and are now covered
    // generically — that hand-enumeration is exactly what went stale when codex
    // added `goals_*`, `memories_*` and `queue_*`.
    const pushExcludes = (id: string, target: 'snapshot' | 'volume'): string[] => {
      const spec = resolveAgentSpec(id);
      const path = spec.staticPaths[0];
      return path ? agentPushExcludes(spec, path, target) : [];
    };

    expect(pushExcludes('claude', 'snapshot')).toEqual([
      ...LIVE_DATABASE_EXCLUDES,
      'node_modules',
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
      '.credentials.json',
    ]);
    expect(pushExcludes('codex', 'snapshot')).toEqual([
      ...LIVE_DATABASE_EXCLUDES,
      'sessions',
      'log',
      'history.jsonl',
      'hooks.json',
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
      'auth.json',
    ]);

    // The credential file is the one entry that differs by target: out of a
    // SHARED snapshot, into the box's OWN volume (which is its login store).
    for (const id of ['claude', 'codex', 'opencode']) {
      const cred = resolveAgentSpec(id).credential.boxRelPath;
      expect(pushExcludes(id, 'snapshot')).toContain(cred);
      expect(pushExcludes(id, 'volume')).not.toContain(cred);
    }

    // Every agent gets the database deny, including one the built-ins don't name.
    for (const spec of AGENT_SYNC_SPECS) {
      const path = spec.staticPaths[0];
      if (!path) continue;
      expect(agentPushExcludes(spec, path, 'volume')).toEqual(
        expect.arrayContaining([...LIVE_DATABASE_EXCLUDES]),
      );
    }
  });

  it('names no database pattern by hand — the deny covers them', () => {
    // The regression guard for the leak: an agent listing its own `*.sqlite`
    // family is the enumeration that goes stale as that agent adds databases.
    for (const spec of AGENT_SYNC_SPECS) {
      for (const path of spec.staticPaths) {
        for (const pattern of path.exclude ?? []) {
          expect(pattern).not.toMatch(/\.(sqlite|db)\b/);
        }
      }
    }
  });

  it('keeps the codex carve-in', () => {
    // The `.tmp/marketplaces` carve-in: emitted before the excludes
    // (first-match-wins) so git-marketplace snapshots reach the box while the
    // rest of `.tmp` (desktop-app payloads) stays out.
    expect(resolveAgentSpec('codex').staticPaths[0]?.include).toEqual([
      '/.tmp/',
      '/.tmp/marketplaces/***',
    ]);
    // opencode data tree. `auth.json` and the `opencode.db` triple are gone
    // from the list — both are derived now — and `snapshot` is the entry the
    // docker copy of this list had been missing.
    expect(resolveAgentSpec('opencode').staticPaths[0]?.exclude).toEqual([
      'storage',
      'log',
      'project',
      'cache',
      'bin',
      'repos',
      'snapshot',
      'config',
    ]);
  });

  it('every spec resolves to itself by its own id', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      expect(resolveAgentSpec(spec.id)).toBe(spec);
    }
  });
});
