import { describe, expect, it } from 'vitest';
import { collectAgentCatalog, type AgentSpecLike } from '../lib/agent-catalog';

// Fake home + fs so this stays pure. These tests must never touch the real home
// directory — apps/hub and apps/cli tests have no HOME isolation.
const HOME = '/fake/home';

// `present` entries are home-relative; `absolute` ones (credential backups) are
// not, because the registry bakes those at module load from the real STATE_DIR.
function fs(present: string[], absolute: string[] = []) {
  const set = new Set([...present.map((p) => `${HOME}/${p}`), ...absolute]);
  return { home: HOME, exists: (p: string) => set.has(p) };
}

const CLAUDE: AgentSpecLike = {
  id: 'claude',
  staticPaths: [{ hostHomeRel: ['.claude'] }],
  credential: { hostBackup: '/state/claude-credentials.json' },
};

// Mirrors the real opencode spec: three static paths, the third being the state
// dir, which is `stagedAs: 'state'` and must never count as host setup.
const OPENCODE: AgentSpecLike = {
  id: 'opencode',
  staticPaths: [
    { hostHomeRel: ['.local', 'share', 'opencode'] },
    { hostHomeRel: ['.config', 'opencode'] },
    { hostHomeRel: ['.local', 'state', 'opencode'], stagedAs: 'state' },
  ],
  credential: { hostBackup: '/state/opencode-credentials.json' },
};

describe('collectAgentCatalog', () => {
  it('lists every spec, whether or not the host is set up for it', () => {
    const out = collectAgentCatalog([CLAUDE, OPENCODE], fs([]));
    expect(out.map((a) => a.id)).toEqual(['claude', 'opencode']);
    expect(out.every((a) => a.installed === false)).toBe(true);
  });

  it('marks an agent installed from its host config dir', () => {
    const [claude] = collectAgentCatalog([CLAUDE], fs(['.claude']));
    expect(claude!.installed).toBe(true);
  });

  it('marks an agent installed from a saved credential alone', () => {
    // The host app can be gone while the AgentBox login still seeds a box.
    const [claude] = collectAgentCatalog([CLAUDE], fs([], ['/state/claude-credentials.json']));
    expect(claude!.installed).toBe(true);
  });

  // The load-bearing case: ~/.local/state/opencode rides along with the config
  // volume but never enables it (create.ts's `wantOpencode` gates on the
  // config/data dirs). Counting it would offer an agent create won't set up.
  it('does not count a `state` static path as host setup', () => {
    const [opencode] = collectAgentCatalog([OPENCODE], fs(['.local/state/opencode']));
    expect(opencode!.installed).toBe(false);
  });

  it("counts either of opencode's non-state dirs", () => {
    expect(collectAgentCatalog([OPENCODE], fs(['.config/opencode']))[0]!.installed).toBe(true);
    expect(collectAgentCatalog([OPENCODE], fs(['.local/share/opencode']))[0]!.installed).toBe(true);
  });

  it('labels the built-ins and falls back to the id for a plugin agent', () => {
    const plugin: AgentSpecLike = { id: 'acme-agent', staticPaths: [{ hostHomeRel: ['.acme'] }] };
    const out = collectAgentCatalog([CLAUDE, OPENCODE, plugin], fs([]));
    expect(out.map((a) => a.label)).toEqual(['Claude', 'OpenCode', 'acme-agent']);
  });

  it('handles a spec with no credential block', () => {
    const plugin: AgentSpecLike = { id: 'acme-agent', staticPaths: [{ hostHomeRel: ['.acme'] }] };
    expect(collectAgentCatalog([plugin], fs([]))[0]!.installed).toBe(false);
    expect(collectAgentCatalog([plugin], fs(['.acme']))[0]!.installed).toBe(true);
  });
});
