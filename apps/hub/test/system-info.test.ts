import { describe, expect, it } from 'vitest';
import {
  bakeVerdict,
  describeHubBuild,
  groupImageContents,
  type ProviderBake,
} from '../lib/system-info';

describe('describeHubBuild', () => {
  it('classifies a plain version as stable', () => {
    const b = describeHubBuild({ version: '0.28.0', source: null });
    expect(b.version).toBe('0.28.0');
    expect(b.channel).toBe('stable');
    expect(b.build).toBeNull();
  });

  it('classifies a -nightly. version as nightly', () => {
    const b = describeHubBuild({ version: '0.28.0-nightly.202607251430' });
    expect(b.channel).toBe('nightly');
  });

  it('renders an npm package build line and keeps the live channel', () => {
    const b = describeHubBuild({ version: '0.28.0', source: { kind: 'package', spec: '0.28.0' } });
    expect(b.build).toBe('@madarco/agentbox@0.28.0 (npm)');
    expect(b.channel).toBe('stable');
  });

  it('uses the ref as the channel for a source build', () => {
    const b = describeHubBuild({
      version: null,
      source: { kind: 'source', repoUrl: 'https://github.com/madarco/agentbox', repoRef: 'nightly' },
    });
    expect(b.channel).toBe('source (nightly)');
    expect(b.build).toBe('https://github.com/madarco/agentbox@nightly (built from source)');
  });

  it('reports null channel when nothing is known', () => {
    expect(describeHubBuild({ version: null }).channel).toBeNull();
  });
});

describe('groupImageContents', () => {
  const keys = [
    'Dockerfile.box',
    'ctl/bin.cjs',
    'share/agentbox-setup/SKILL.md',
    'scripts/agentbox-vnc-start',
    'scripts/custom-system-CLAUDE.md',
    'scripts/claude-managed-settings.json',
    'scripts/agentbox-codex-hooks.json',
    'scripts/agentbox-open',
  ];

  it('buckets keys into fixed categories in order', () => {
    const groups = groupImageContents(keys);
    expect(groups.map((g) => g.category)).toEqual(['Agent config & skills', 'Runtime scripts', 'Base image']);
    const agent = groups.find((g) => g.category === 'Agent config & skills')!;
    expect(agent.files.map((f) => f.path)).toContain('share/agentbox-setup/SKILL.md');
    expect(agent.files.map((f) => f.path)).toContain('scripts/custom-system-CLAUDE.md');
    const base = groups.find((g) => g.category === 'Base image')!;
    expect(base.files.map((f) => f.path).sort()).toEqual(['Dockerfile.box', 'ctl/bin.cjs']);
  });

  it('labels well-known files and falls back to the basename', () => {
    const groups = groupImageContents(['scripts/agentbox-vnc-start', 'scripts/unknown-thing']);
    const scripts = groups.find((g) => g.category === 'Runtime scripts')!;
    const byPath = Object.fromEntries(scripts.files.map((f) => [f.path, f.label]));
    expect(byPath['scripts/agentbox-vnc-start']).toBe('VNC start script');
    expect(byPath['scripts/unknown-thing']).toBe('unknown-thing');
  });

  it('drops empty categories', () => {
    const groups = groupImageContents(['Dockerfile.box']);
    expect(groups.map((g) => g.category)).toEqual(['Base image']);
  });
});

describe('bakeVerdict', () => {
  const base: ProviderBake = { id: 'hetzner', label: 'Hetzner', baked: true };

  it('flags stale as a warning', () => {
    expect(bakeVerdict({ ...base, baseStatus: 'stale', baseStaleReason: 'x' }).tone).toBe('warn');
  });

  it('treats unbaked / unprepared as muted', () => {
    expect(bakeVerdict({ ...base, baked: false }).tone).toBe('muted');
    expect(bakeVerdict({ ...base, baseStatus: 'unprepared' }).tone).toBe('muted');
  });

  it('treats fresh as ok', () => {
    expect(bakeVerdict({ ...base, baseStatus: 'fresh' }).tone).toBe('ok');
  });
});
