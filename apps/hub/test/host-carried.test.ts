import { describe, expect, it } from 'vitest';
import { collectHostCarried, filterSkillNames, type AgentSpecLike } from '../lib/host-carried';

// Fake home + fs so this stays pure. These tests must never touch the real
// home directory — apps/hub and apps/cli tests have no HOME isolation.
const HOME = '/fake/home';

function fs(present: string[], dirs: Record<string, string[]> = {}) {
  const set = new Set(present.map((p) => `${HOME}/${p}`));
  return {
    home: HOME,
    exists: (p: string) => set.has(p),
    childDirs: (p: string) => dirs[p.replace(`${HOME}/`, '')] ?? [],
  };
}

const SPECS: AgentSpecLike[] = [
  { id: 'claude', staticPaths: [{ hostHomeRel: ['.claude'] }] },
  { id: 'codex', staticPaths: [{ hostHomeRel: ['.codex'] }] },
  {
    id: 'opencode',
    staticPaths: [
      { hostHomeRel: ['.local', 'share', 'opencode'] },
      { hostHomeRel: ['.config', 'opencode'] },
    ],
  },
];

describe('collectHostCarried', () => {
  // The whole contract: every consumer of these paths gates on existence, so a
  // path that isn't present is a path a box will not receive. Listing an absent
  // one would be a lie about what the box gets.
  it('lists nothing when the home has no agent config', () => {
    expect(collectHostCarried(SPECS, fs([]))).toEqual([]);
  });

  it('includes only paths that exist', () => {
    const out = collectHostCarried(SPECS, fs(['.claude', '.config/opencode']));
    expect(out.map((e) => e.hostPath)).toEqual(['~/.claude', '~/.config/opencode']);
  });

  it('enumerates skill names for ~/.agents', () => {
    const out = collectHostCarried(
      SPECS,
      fs(['.agents', '.agents/skills'], { '.agents/skills': ['dataviz', 'unslop'] }),
    );
    const agents = out.find((e) => e.agent === 'agents');
    expect(agents?.kind).toBe('skills');
    expect(agents?.skills).toEqual(['dataviz', 'unslop']);
  });

  it('marks an agent dir with a skills/ subdir as a skills entry', () => {
    const out = collectHostCarried(
      SPECS,
      fs(['.claude', '.claude/skills'], { '.claude/skills': ['code-review'] }),
    );
    const claude = out.find((e) => e.hostPath === '~/.claude');
    expect(claude?.kind).toBe('skills');
    expect(claude?.skills).toEqual(['code-review']);
  });

  it('treats an agent dir without skills/ as plain config', () => {
    const out = collectHostCarried(SPECS, fs(['.codex']));
    expect(out.find((e) => e.hostPath === '~/.codex')?.kind).toBe('config');
  });

  it('includes ~/.gitconfig as identity and ~/.claude.json as config', () => {
    const out = collectHostCarried(SPECS, fs(['.gitconfig', '.claude.json']));
    expect(out.find((e) => e.hostPath === '~/.gitconfig')?.kind).toBe('identity');
    expect(out.find((e) => e.hostPath === '~/.claude.json')?.kind).toBe('config');
  });

  it('renders nested spec paths with the full ~ path', () => {
    const out = collectHostCarried(SPECS, fs(['.local/share/opencode']));
    expect(out[0]?.hostPath).toBe('~/.local/share/opencode');
  });

  it('does not invent a skills list when skills/ is absent', () => {
    const out = collectHostCarried(SPECS, fs(['.agents']));
    expect(out.find((e) => e.agent === 'agents')?.skills).toBeUndefined();
  });
});

describe('skill enumeration hygiene', () => {
  it('omits dot-directories, which are machinery not skills', () => {
    // Real cases: codex ships `.system` and `.cursor` appears under ~/.agents.
    // Counting them inflates "N skills" with things the user never wrote. The
    // filter lives in the default childDirs, so assert it through readdir shape.
    expect(filterSkillNames(['.system', '.cursor', 'dataviz', 'unslop'])).toEqual([
      'dataviz',
      'unslop',
    ]);
  });
});
