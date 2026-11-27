import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { agentCommandEntry } from '../src/agents/commands.js';
import { cloudSizingFlags } from '../src/agents/command/create-action.js';
import type { AgentCreateOptions } from '../src/agents/command/options.js';
import { buildHubCreateOpts } from '../src/lib/hub-create-opts.js';
import { cloudSizingProviderOptions, locationIgnoredWarning } from '../src/lib/cloud-sizing.js';

function makeCfg(box: Record<string, unknown> = {}): EffectiveConfig {
  return {
    box: {
      size: '',
      sizeHetzner: 'cx23',
      hetznerLocation: 'nbg1',
      imageRegistry: '',
      defaultCheckpoint: '',
      defaultCheckpointHetzner: '',
      ...box,
    },
  } as unknown as EffectiveConfig;
}

/** Parse `agentbox claude <argv>` with commander, without running the action. */
function parseClaude(argv: string[]): AgentCreateOptions {
  const entry = agentCommandEntry('claude');
  if (!entry) throw new Error('no claude command');
  const cmd = entry.command;
  cmd.exitOverride();
  cmd.action(() => {});
  // The command is a singleton: clear the previous parse's values.
  for (const o of cmd.options) cmd.setOptionValue(o.attributeName(), o.defaultValue);
  cmd.parse(['node', 'claude', ...argv]);
  return cmd.opts<AgentCreateOptions>();
}

describe('agent commands take --size and --location', () => {
  it('claude parses both and they reach the hub create request', () => {
    const opts = parseClaude(['--provider', 'hetzner', '--size', 'cx33', '--location', 'hel1']);
    expect(cloudSizingFlags(opts)).toEqual({ size: 'cx33', location: 'hel1' });

    const { opts: wire } = buildHubCreateOpts({
      providerName: 'hetzner',
      cfg: makeCfg(),
      flags: cloudSizingFlags(opts),
    });
    expect(wire.size).toBe('cx33');
    expect(wire.location).toBe('hel1');
    expect(wire.providerOptions).toMatchObject({
      size: 'cx33',
      location: 'hel1',
      locationPinned: true,
    });
  });

  it('without the flags the request carries config, unpinned', () => {
    const opts = parseClaude(['--provider', 'hetzner']);
    expect(cloudSizingFlags(opts)).toEqual({});
    const { opts: wire } = buildHubCreateOpts({
      providerName: 'hetzner',
      cfg: makeCfg(),
      flags: cloudSizingFlags(opts),
    });
    expect(wire.size).toBe('cx23');
    expect(wire.location).toBe('nbg1');
    expect(wire.providerOptions).not.toHaveProperty('locationPinned');
  });

  it('the local create path gets the same provider options', () => {
    const opts = parseClaude(['--provider', 'hetzner', '--location', 'fsn1']);
    expect(cloudSizingProviderOptions('hetzner', makeCfg(), cloudSizingFlags(opts))).toMatchObject({
      size: 'cx23',
      location: 'fsn1',
      locationPinned: true,
    });
  });

  it('every visible agent and openclaw declare both flags', () => {
    for (const id of ['claude', 'codex', 'opencode', 'pi', 'openclaw']) {
      const cmd = agentCommandEntry(id)?.command;
      if (!cmd) continue;
      const flags = cmd.options.map((o) => o.long);
      expect(flags, id).toContain('--size');
      expect(flags, id).toContain('--location');
    }
  });

  it('warns, without failing, for a provider without locations', () => {
    expect(locationIgnoredWarning('vercel', 'fsn1')).toMatch(/ignored for provider vercel/);
    expect(locationIgnoredWarning('hetzner', 'fsn1')).toBeNull();
    expect(locationIgnoredWarning('vercel', undefined)).toBeNull();
  });
});
