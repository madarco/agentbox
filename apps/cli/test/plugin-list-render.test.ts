import { describe, expect, it } from 'vitest';
import type { PluginRecord } from '@agentbox/sandbox-core';
import { pluginListFooter, renderPluginRow } from '../src/commands/plugin.js';

const rec = (over: Partial<PluginRecord> = {}): PluginRecord => ({
  packageName: 'agentbox-provider-fly',
  resolvedEntry: '/tmp/fly/dist/index.js',
  version: '1.2.0',
  providers: ['fly'],
  apiVersion: 4,
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('renderPluginRow', () => {
  it('indents a supported row so it lines up under the marked ones', () => {
    const row = renderPluginRow(rec(), [4]);
    expect(row).toBe('   fly                  agentbox-provider-fly@1.2.0 (SDK v4)\n');
  });

  it('marks an unsupported row with a greppable leading "!"', () => {
    const row = renderPluginRow(
      rec({
        packageName: '@tenkicloud/agentbox-provider',
        version: '0.1.1',
        providers: ['tenki'],
        apiVersion: 2,
      }),
      [4],
    );
    expect(row.startsWith('!  ')).toBe(true);
    expect(row).toContain('(SDK v2 — unsupported, this build needs v4)');
  });

  it('names every supported major, so the text survives the gate widening', () => {
    expect(renderPluginRow(rec({ apiVersion: 2 }), [4, 5])).toContain('this build needs v4/v5');
  });

  it('keeps the package column aligned across marked and unmarked rows', () => {
    const at = (row: string) => row.indexOf('agentbox-provider-fly@');
    expect(at(renderPluginRow(rec(), [4]))).toBe(at(renderPluginRow(rec({ apiVersion: 2 }), [4])));
  });
});

describe('pluginListFooter', () => {
  it('is null when every plugin loads', () => {
    expect(pluginListFooter([rec(), rec({ packageName: 'b', providers: ['b'] })], [4])).toBeNull();
  });

  it('explains the marker and names both escape hatches', () => {
    const footer = pluginListFooter([rec(), rec({ apiVersion: 2 })], [4]);
    expect(footer).toContain('agentbox self-update');
    expect(footer).toContain('agentbox plugin remove');
  });

  it('is null for an empty registry', () => {
    expect(pluginListFooter([], [4])).toBeNull();
  });

  it('never starts a line with "!", so `grep -c "^!"` counts rows only', () => {
    const footer = pluginListFooter([rec({ apiVersion: 2 })], [4]) ?? '';
    expect(footer.split('\n').some((l) => l.startsWith('!'))).toBe(false);
  });
});
