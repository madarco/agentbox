import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { buildHubCreateOpts } from '../src/lib/hub-create-opts.js';

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
