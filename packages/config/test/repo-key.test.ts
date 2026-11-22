import { describe, expect, it } from 'vitest';
import { custodySlugForRepoKey, localRepoPath, repoKey } from '../src/repo-key.js';

describe('repoKey', () => {
  // The spike's disagreement table (docs/box-sources-plan.md §1.3): every
  // spelling of one repo must land on one key.
  it.each([
    ['git@github.com:Madarco/AgentBox.git', 'github.com/madarco/agentbox'],
    ['https://github.com/madarco/agentbox', 'github.com/madarco/agentbox'],
    ['ssh://git@github.com:22/madarco/agentbox.git', 'github.com/madarco/agentbox'],
    ['ssh://git@github.com/madarco/agentbox/', 'github.com/madarco/agentbox'],
    ['https://user:secret@github.com/madarco/agentbox.git', 'github.com/madarco/agentbox'],
    ['https://github.com:443/madarco/agentbox', 'github.com/madarco/agentbox'],
    ['git://github.com/madarco/agentbox.git', 'github.com/madarco/agentbox'],
    ['github.com/madarco/agentbox', 'github.com/madarco/agentbox'],
  ])('%s -> %s', (url, key) => {
    expect(repoKey(url)).toBe(key);
  });

  it('keeps the host, so github and gitlab are two repos', () => {
    expect(repoKey('https://gitlab.com/madarco/agentbox.git')).toBe('gitlab.com/madarco/agentbox');
    expect(repoKey('https://gitlab.com/madarco/agentbox.git')).not.toBe(
      repoKey('https://github.com/madarco/agentbox.git'),
    );
  });

  it('keeps GitLab subgroups and drops a non-standard port', () => {
    expect(repoKey('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toBe(
      'gitlab.example.com/group/sub/repo',
    );
    expect(repoKey('git@gitlab.example.com:group/sub/repo.git')).toBe(
      'gitlab.example.com/group/sub/repo',
    );
  });

  it('expands an ssh alias only for non-http(s) remotes', () => {
    const expandHost = (h: string) => (h === 'github-work' ? 'github.com' : null);
    expect(repoKey('git@github-work:madarco/agentbox.git', { expandHost })).toBe(
      'github.com/madarco/agentbox',
    );
    expect(repoKey('ssh://git@github-work/madarco/agentbox', { expandHost })).toBe(
      'github.com/madarco/agentbox',
    );
    expect(repoKey('https://github-work/madarco/agentbox', { expandHost })).toBe(
      'github-work/madarco/agentbox',
    );
    // Unexpanded, the alias stays as written: the hub never guesses.
    expect(repoKey('git@github-work:madarco/agentbox.git')).toBe('github-work/madarco/agentbox');
  });

  it('keys a local path by machine, case preserved', () => {
    expect(repoKey('/Users/me/src/AgentBox.git', { machineId: 'm1' })).toBe(
      'local:m1:/Users/me/src/AgentBox',
    );
    expect(repoKey('file:///srv/repos/app/', { machineId: 'm1' })).toBe('local:m1:/srv/repos/app');
    expect(repoKey('/Users/me/src/agentbox')).toBeUndefined();
  });

  it('has no key for empty or unparseable values', () => {
    expect(repoKey('')).toBeUndefined();
    expect(repoKey(undefined)).toBeUndefined();
    expect(repoKey('https://github.com')).toBeUndefined();
    expect(repoKey('nonsense')).toBeUndefined();
  });

  it('is idempotent', () => {
    const k = repoKey('git@github.com:Madarco/AgentBox.git')!;
    expect(repoKey(k)).toBe(k);
  });
});

describe('localRepoPath', () => {
  it('strips .git and trailing slashes, keeps case', () => {
    expect(localRepoPath('/Srv/App.git/')).toBe('/Srv/App');
    expect(localRepoPath('git@github.com:o/r')).toBeUndefined();
  });
});

describe('custodySlugForRepoKey', () => {
  it('is case-insensitive and keeps host + subgroups (the old slug did neither)', () => {
    expect(custodySlugForRepoKey(repoKey('git@github.com:Madarco/AgentBox.git'))).toBe(
      'github.com__madarco__agentbox',
    );
    expect(custodySlugForRepoKey(repoKey('https://gitlab.com/madarco/agentbox'))).toBe(
      'gitlab.com__madarco__agentbox',
    );
    expect(custodySlugForRepoKey('gitlab.example.com/group/sub/repo')).toBe(
      'gitlab.example.com__group__sub__repo',
    );
  });

  it('sanitises to the custody charset', () => {
    expect(custodySlugForRepoKey('host/o w/r+x')).toBe('host__o-w__r-x');
  });

  it('caps a long slug with a hash suffix, still unique and stable', () => {
    const a = `host/${'a'.repeat(120)}/one`;
    const b = `host/${'a'.repeat(120)}/two`;
    const sa = custodySlugForRepoKey(a)!;
    expect(sa.length).toBeLessThanOrEqual(80);
    expect(sa).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(sa).not.toBe(custodySlugForRepoKey(b));
    expect(custodySlugForRepoKey(a)).toBe(sa);
  });

  it('has no slug for a local key or nothing', () => {
    expect(custodySlugForRepoKey('local:m1:/srv/app')).toBeNull();
    expect(custodySlugForRepoKey(undefined)).toBeNull();
  });
});
