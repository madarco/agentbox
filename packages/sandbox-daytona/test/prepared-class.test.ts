import { describe, expect, it } from 'vitest';
import { preparedMatches, type PreparedDaytonaState } from '../src/prepared-state.js';
import type { DaytonaSandboxClass } from '@agentbox/config';

const SHA = 'b'.repeat(64);

function state(over: { size?: string; class?: DaytonaSandboxClass }): PreparedDaytonaState {
  const extras = {
    ...(over.size ? { size: over.size } : {}),
    ...(over.class ? { class: over.class } : {}),
  };
  return {
    schema: 1,
    base: {
      imageRef: 'agentbox-base-bbbbbbbbbbbb',
      contextSha256: SHA,
      cliVersion: '0.0.0',
      createdAt: '2026-07-12T00:00:00Z',
    },
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}

describe('daytona preparedMatches — sandbox class', () => {
  it('matches when the baked class equals the requested one', () => {
    expect(preparedMatches(state({ class: 'linux-vm' }), SHA, undefined, 'linux-vm')).toBe(true);
    expect(preparedMatches(state({ class: 'container' }), SHA, undefined, 'container')).toBe(true);
  });

  it('rejects a container snapshot when a VM was asked for, and vice versa', () => {
    // The classes are not interchangeable: a snapshot of one class cannot create
    // a sandbox of the other, so a mismatch has to force a re-bake.
    expect(preparedMatches(state({ class: 'container' }), SHA, undefined, 'linux-vm')).toBe(false);
    expect(preparedMatches(state({ class: 'linux-vm' }), SHA, undefined, 'container')).toBe(false);
  });

  it('treats a class-less snapshot as a container (it predates the class field)', () => {
    // Snapshots baked before linux-vm existed carry no `class` extra, but they
    // were necessarily containers. They must NOT satisfy a linux-vm request --
    // that would boot a container box that silently cannot pause.
    expect(preparedMatches(state({}), SHA, undefined, 'container')).toBe(true);
    expect(preparedMatches(state({}), SHA, undefined, 'linux-vm')).toBe(false);
  });

  it('ignores class when the caller does not ask for one (back-compat)', () => {
    expect(preparedMatches(state({ class: 'linux-vm' }), SHA)).toBe(true);
    expect(preparedMatches(state({}), SHA)).toBe(true);
  });

  it('still requires the size to match alongside the class', () => {
    expect(preparedMatches(state({ size: '4-8-20', class: 'linux-vm' }), SHA, '4-8-20', 'linux-vm')).toBe(true);
    expect(preparedMatches(state({ size: '4-8-20', class: 'linux-vm' }), SHA, '2-4-8', 'linux-vm')).toBe(false);
  });

  it('rejects on a fingerprint mismatch regardless of class', () => {
    expect(preparedMatches(state({ class: 'linux-vm' }), 'c'.repeat(64), undefined, 'linux-vm')).toBe(
      false,
    );
  });
});
