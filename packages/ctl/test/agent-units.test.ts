import { describe, expect, it } from 'vitest';
import { agentUnitsFromWire, mergeAgentUnits } from '../src/agent-units.js';
import { parseConfig, type CtlConfig } from '../src/config.js';

/**
 * The wire→units narrowing and the workspace-wins fold.
 *
 * The payload comes from a host that may be NEWER than this baked ctl, so the
 * posture under test is: narrow defensively, drop what you cannot use with a
 * warning, and never let a malformed agent row cost the box the supervisor it
 * already had.
 */
const warnings: string[] = [];
const warn = (m: string): void => void warnings.push(m);

function fresh(): void {
  warnings.length = 0;
}

const service = {
  name: 'gateway',
  command: 'demo gateway',
  restart: 'always',
  needs: ['gateway-render'],
  readyWhen: { http: 'http://127.0.0.1:18789/healthz' },
  expose: { port: 18789, as: 80 },
  tasks: [
    { name: 'gateway-onboard', command: 'demo onboard', runOnce: 'marker' },
    {
      name: 'gateway-render',
      command: 'agentbox-ctl agent render demo',
      needs: ['gateway-onboard'],
    },
  ],
};

describe('agentUnitsFromWire', () => {
  it('copies the block field-for-field, applying ctl’s own defaults', () => {
    fresh();
    const u = agentUnitsFromWire('demo', service, warn);
    expect(u).not.toBeNull();
    expect(u!.services).toHaveLength(1);
    const s = u!.services[0]!;
    expect(s.name).toBe('gateway');
    expect(s.command).toBe('demo gateway');
    expect(s.restart).toBe('always');
    expect(s.autostart).toBe(true);
    expect(s.needs).toEqual(['gateway-render']);
    expect(s.readyWhen?.kind).toBe('http');
    expect(s.expose).toEqual({ port: 18789, as: 80 });
    expect(u!.tasks.map((t) => t.name)).toEqual(['gateway-onboard', 'gateway-render']);
    expect(u!.tasks[0]!.runOnce).toEqual({ kind: 'marker' });
    expect(warnings).toEqual([]);
  });

  it('drops the agent’s units rather than throwing when the name is unusable', () => {
    fresh();
    expect(agentUnitsFromWire('demo', { ...service, name: 'bad name' }, warn)).toBeNull();
    expect(warnings.join(' ')).toMatch(/not a valid unit name/);
  });

  it('drops the agent’s units when the command is missing', () => {
    fresh();
    expect(agentUnitsFromWire('demo', { name: 'gateway' }, warn)).toBeNull();
    expect(warnings.join(' ')).toMatch(/command is missing/);
  });

  it('drops one malformed task and keeps the rest', () => {
    fresh();
    const u = agentUnitsFromWire(
      'demo',
      { ...service, tasks: [{ name: 'ok', command: 'true' }, { name: 'broken' }] },
      warn,
    );
    expect(u!.tasks.map((t) => t.name)).toEqual(['ok']);
    expect(warnings.join(' ')).toMatch(/malformed/);
  });

  it('ignores an unparseable log_match instead of failing the unit', () => {
    fresh();
    const u = agentUnitsFromWire(
      'demo',
      { ...service, readyWhen: { logMatch: '(unclosed' } },
      warn,
    );
    expect(u!.services[0]!.readyWhen).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/not a valid regex/);
  });
});

describe('mergeAgentUnits', () => {
  const base = (yaml: string): CtlConfig => parseConfig(yaml);

  it('adds the agent’s units to a workspace that declares none', () => {
    fresh();
    const merged = mergeAgentUnits(base(''), [agentUnitsFromWire('demo', service, warn)!], warn);
    expect(merged.services.map((s) => s.name)).toEqual(['gateway']);
    expect(merged.tasks.map((t) => t.name)).toEqual(['gateway-onboard', 'gateway-render']);
  });

  it('lets a same-named workspace unit WIN', () => {
    fresh();
    const workspace = base('services:\n  gateway:\n    command: my own gateway\n');
    const merged = mergeAgentUnits(
      workspace,
      [agentUnitsFromWire('demo', { ...service, needs: [] }, warn)!],
      warn,
    );
    expect(merged.services).toHaveLength(1);
    expect(merged.services[0]!.command).toBe('my own gateway');
    expect(warnings.join(' ')).toMatch(/the workspace wins/);
  });

  it('drops the agent’s expose when the workspace already publishes port 80', () => {
    fresh();
    const workspace = base(
      'services:\n  web:\n    command: pnpm dev\n    expose:\n      port: 3000\n',
    );
    const merged = mergeAgentUnits(
      workspace,
      [agentUnitsFromWire('demo', { ...service, needs: [] }, warn)!],
      warn,
    );
    expect(merged.services.find((s) => s.name === 'gateway')?.expose).toBeUndefined();
    expect(merged.services.find((s) => s.name === 'web')?.expose).toEqual({ port: 3000, as: 80 });
    expect(warnings.join(' ')).toMatch(/already publishes the box web port/);
  });

  it('keeps the workspace config when the merged graph would be invalid', () => {
    fresh();
    const workspace = base('services:\n  web:\n    command: pnpm dev\n');
    // `needs: [ghost]` dangles — the whole fold is rejected rather than leaving
    // a unit blocked forever on a dependency that will never exist.
    const merged = mergeAgentUnits(
      workspace,
      [agentUnitsFromWire('demo', { name: 'gateway', command: 'x', needs: ['ghost'] }, warn)!],
      warn,
    );
    expect(merged.services.map((s) => s.name)).toEqual(['web']);
    expect(warnings.join(' ')).toMatch(/agent units rejected/);
  });

  it('is a no-op when no agent contributed units', () => {
    const workspace = base('services:\n  web:\n    command: pnpm dev\n');
    expect(mergeAgentUnits(workspace, [], warn)).toBe(workspace);
  });
});
