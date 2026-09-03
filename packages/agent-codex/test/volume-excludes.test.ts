import { describe, expect, it } from 'vitest';
import { agentPushExcludes, LIVE_DATABASE_EXCLUDES, requireAgentCredential } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { volumeExcludeFlags, volumeIncludeFlags, volumePurgeCommand } from '../src/docker-sync.js';

/**
 * The docker volume push and the cloud snapshot push render ONE list.
 *
 * They used to hold two, and the two had drifted in both directions: the volume
 * was still receiving codex's host-identity files (`installation_id`,
 * `version.json`, `.codex-global-state.json`, `.personality_migration`) that the
 * snapshot dropped, while codex's newer databases were excluded by neither and
 * shipped live into every box.
 */
const spec = resolveAgentSpec('codex');
const path = spec.staticPaths[0]!;

describe('codex docker-volume excludes', () => {
  const flags = volumeExcludeFlags();
  const patterns = flags.split(' ').map((f) => f.replace(/^--exclude=/, ''));

  it('renders every registry exclude', () => {
    for (const p of path.exclude ?? []) expect(patterns).toContain(p);
  });

  it('renders the live-database deny', () => {
    for (const p of LIVE_DATABASE_EXCLUDES) expect(patterns).toContain(p);
  });

  it('drops the databases that used to ship — including the three nobody listed', () => {
    // `goals_1`, `memories_1` and `queue_1` appeared in codex after the
    // hand-written list was written, and carried cross-project thread goals and
    // extracted memories into every box.
    const shipped = (name: string): boolean => !patterns.some((p) => matches(p, name));
    for (const name of [
      'state_5.sqlite',
      'state_5.sqlite-wal',
      'logs_2.sqlite-shm',
      'goals_1.sqlite',
      'goals_1.sqlite-wal',
      'goals_1.sqlite-shm',
      'memories_1.sqlite',
      'memories_1.sqlite-wal',
      'memories_1.sqlite-shm',
      'queue_1.sqlite',
      'queue_1.sqlite-wal',
      'queue_1.sqlite-shm',
    ]) {
      expect(shipped(name), `${name} would ship into the box`).toBe(false);
    }
  });

  it('KEEPS the credential file — the volume is the box login store', () => {
    // Codex declares one; `requireAgentCredential` states that rather than
    // letting an optional-chained `undefined` make both assertions vacuous.
    const cred = requireAgentCredential(spec);
    expect(patterns).not.toContain(cred.boxRelPath);
    // ...while the shared snapshot must not carry it.
    expect(agentPushExcludes(spec, path, 'snapshot')).toContain(cred.boxRelPath);
  });

  it('keeps config.toml out (reconciled separately) and the carve-in first', () => {
    expect(patterns).toContain('/config.toml');
    expect(volumeIncludeFlags(path)).toBe('--include=/.tmp/ --include=/.tmp/marketplaces/***');
  });

  it('purges only removable paths — no anchored or bare-dot patterns', () => {
    const purge = volumePurgeCommand();
    expect(purge.startsWith('rm -rf ')).toBe(true);
    expect(purge).not.toContain('/dst//');
    expect(purge).not.toMatch(/\/dst\/\.tmp(\s|$)/);
    expect(purge).toContain('/dst/*.sqlite*');
  });
});

/** Minimal glob match for the shapes these patterns use. */
function matches(pattern: string, name: string): boolean {
  const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return rx.test(name);
}
