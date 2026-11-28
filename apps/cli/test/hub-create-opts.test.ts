import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { buildHubCreateOpts, readProjectGitIdentity } from '../src/lib/hub-create-opts.js';
import { edgeLlmProxyMode } from '../src/lib/llm-proxy-flag.js';

// Only the `box` slice is read; cast a minimal shape through unknown.
function makeCfg(box: Record<string, unknown> = {}): EffectiveConfig {
  return {
    box: {
      size: '',
      sizeDocker: '',
      sizeDaytona: '',
      sizeHetzner: '',
      sizeVercel: '',
      sizeE2b: '',
      hetznerLocation: '',
      imageRegistry: '',
      vercelTimeoutMs: 2_700_000,
      vercelNetworkPolicy: 'strict',
      e2bTimeoutMs: 120_000,
      daytonaClass: 'linux-vm',
      daytonaRegion: '',
      daytonaTimeoutMs: 1_500_000,
      defaultCheckpoint: '',
      defaultCheckpointHetzner: '',
      ...box,
    },
  } as unknown as EffectiveConfig;
}

const hetzner = (box: Record<string, unknown> = {}, flags = {}) =>
  buildHubCreateOpts({ providerName: 'hetzner', cfg: makeCfg(box), flags });

describe('what a control-box create carries', () => {
  it("sends the project's size even though no flag was typed", () => {
    // The agent commands declare no --size at all, so this path is purely the
    // project's config — which the control box cannot read.
    const { opts } = hetzner({ sizeHetzner: 'cx33' });
    expect(opts.size).toBe('cx33');
    expect(opts.providerOptions).toMatchObject({ size: 'cx33' });
  });

  it("sends the project's default checkpoint, not just an explicit --snapshot", () => {
    // `box.defaultCheckpoint*` never travelled: the CLI resolved it below the
    // branch that returns for a remote create.
    expect(hetzner({ defaultCheckpointHetzner: 'warm-1' }).opts.snapshot).toBe('warm-1');
    expect(
      hetzner({ defaultCheckpointHetzner: 'warm-1' }, { snapshot: 'other' }).opts.snapshot,
    ).toBe('other');
  });

  it('carries per-provider knobs the old senders never mentioned', () => {
    const { opts } = buildHubCreateOpts({
      providerName: 'vercel',
      cfg: makeCfg({ vercelTimeoutMs: 600_000 }),
      flags: {},
    });
    expect(opts.providerOptions).toMatchObject({ timeoutMs: 600_000 });
  });

  it('never hands the hub its own two keys', () => {
    // extraInboundCidrs opens a firewall; remoteHost names an engine the hub owns.
    const { opts } = buildHubCreateOpts({
      providerName: 'hetzner',
      remoteHost: 'buildbox',
      cfg: makeCfg(),
      flags: {},
    });
    expect(opts.providerOptions ?? {}).not.toHaveProperty('remoteHost');
    expect(opts.providerOptions ?? {}).not.toHaveProperty('extraInboundCidrs');
  });

  it('sends nothing the caller did not ask for', () => {
    // An empty bag means the control box's own config still decides.
    expect(hetzner().opts).toEqual({});
  });
});

describe('what it refuses to pretend about', () => {
  it('names a docker-only flag, why, and what to do instead', () => {
    const { warnings } = hetzner({}, { memory: '4g' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--memory');
    expect(warnings[0]).toContain('--size');
    // The honest part: it IS recorded, so `show` will display it.
    expect(warnings[0]).toContain('agentbox show');
  });

  it('stays silent when the same value came from config, not a flag', () => {
    // Warning on config would fire on every create for anyone who has one, and
    // that is how a warning becomes noise nobody reads.
    expect(hetzner({ memory: '4g' }).warnings).toEqual([]);
  });

  it('warns about --build for a cloud box and not for a docker engine', () => {
    expect(hetzner({}, { build: true }).warnings).toHaveLength(1);
    const viaEngine = buildHubCreateOpts({
      providerName: 'remote-docker',
      remoteHost: 'buildbox',
      cfg: makeCfg(),
      flags: { build: true },
    });
    expect(viaEngine.warnings).toEqual([]);
    expect(viaEngine.opts.build).toBe(true);
  });

  it('warns that a host clone and a local alias stay home', () => {
    expect(hetzner({}, { hostSnapshot: true }).warnings[0]).toContain('--local');
    expect(hetzner({}, { portless: true }).warnings[0]).toContain('public URL');
  });
});

describe('--llm-proxy on a hub-routed create (llm-accounts Phase 7)', () => {
  it('sends the mode, never an upstream; absent when not asked', () => {
    const base = { providerName: 'hetzner', cfg: makeCfg(), flags: {} };
    expect(buildHubCreateOpts({ ...base, resolved: { llmProxy: 'forward' } }).opts.llmProxy).toBe(
      'forward',
    );
    expect(buildHubCreateOpts({ ...base, resolved: { llmProxy: 'off' } }).opts.llmProxy).toBe(
      'off',
    );
    expect('llmProxy' in buildHubCreateOpts(base).opts).toBe(false);
  });
  it('edgeLlmProxyMode: the flag, else the project key when on; a typo throws', () => {
    const cfg = (proxy: 'off' | 'forward') => ({ llm: { proxy } }) as unknown as EffectiveConfig;
    expect(edgeLlmProxyMode(undefined, cfg('off'))).toBeUndefined();
    expect(edgeLlmProxyMode(undefined, cfg('forward'))).toBe('forward');
    expect(edgeLlmProxyMode('off', cfg('forward'))).toBe('off');
    expect(() => edgeLlmProxyMode('fwd', cfg('off'))).toThrow(/--llm-proxy/);
  });
});

describe("the requester's committer identity", () => {
  it("sends the project's effective identity, repo-local override included", async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = mkdtempSync(join(tmpdir(), 'agentbox-hub-gitid-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      // Repo-local config wins over any global identity on the test host.
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Ada Lovelace']);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'ada@example.com']);
      const { opts } = buildHubCreateOpts({
        providerName: 'hetzner',
        cfg: makeCfg(),
        flags: {},
        projectRoot: repo,
      });
      expect(opts.gitIdentity).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sends none, and warns, when the project has no complete identity', () => {
    // Silently falling back would let a second user of a shared hub commit as
    // whoever enrolled first.
    const { opts, warnings } = buildHubCreateOpts({
      providerName: 'hetzner',
      cfg: makeCfg(),
      flags: {},
      projectRoot: '/nowhere',
      readGitIdentity: () => ({ problem: 'no user.email' }),
    });
    expect('gitIdentity' in opts).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no complete git identity (no user.email)');
    expect(warnings[0]).toContain("hub's default identity");
  });

  it('names the missing half and refuses a value the hub would reject', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = mkdtempSync(join(tmpdir(), 'agentbox-hub-gitid-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const prev = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      execFileSync('git', ['init', '-q', repo], { env });
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Ada'], { env });
      expect(readProjectGitIdentity(repo)).toEqual({ problem: 'no user.email' });
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'ada@example.com\u0007'], { env });
      expect(readProjectGitIdentity(repo)).toMatchObject({
        problem: expect.stringMatching(/control/),
      });
    } finally {
      if (prev.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev.g;
      if (prev.s === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prev.s;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('also rides a docker:<alias> create', () => {
    const { opts } = buildHubCreateOpts({
      providerName: 'remote-docker',
      remoteHost: 'devbox',
      cfg: makeCfg(),
      flags: {},
      projectRoot: '/p',
      readGitIdentity: () => ({ identity: { name: 'Ada', email: 'ada@example.com' } }),
    });
    expect(opts.gitIdentity).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });
});
