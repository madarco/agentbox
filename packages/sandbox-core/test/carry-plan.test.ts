import { describe, expect, it } from 'vitest';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { planCarryEntry } from '../src/sync/concerns/files.js';

function entry(over: Partial<ResolvedCarryEntry>): ResolvedCarryEntry {
  return {
    rawSrc: '~/.agentbox/x',
    rawDest: '~/.agentbox/x',
    absSrc: '/host/.agentbox/x',
    absDest: '~/.agentbox/x',
    kind: 'file',
    bytes: 1,
    optional: false,
    ...over,
  };
}

describe('planCarryEntry', () => {
  it('returns null for a missing entry (both providers skip it)', () => {
    expect(planCarryEntry(entry({ kind: 'missing' }))).toBeNull();
  });

  it('expands ~/ to /home/vscode host-side and defaults the owner to the box user', () => {
    const p = planCarryEntry(entry({ absDest: '~/.agentbox/marker.txt' }))!;
    expect(p.boxDest).toBe('/home/vscode/.agentbox/marker.txt');
    expect(p.parentDir).toBe('/home/vscode/.agentbox');
    expect(p.chownArgs).toEqual(['--reference=/home/vscode']);
    expect(p.isDir).toBe(false);
  });

  // The bug this replaced: 1000 is `vscode` on docker/hetzner/digitalocean/
  // daytona but NOT on vercel/e2b, where `useradd` runs without `-u`. Baking
  // any number into the default silently hands carried files to a stranger.
  it('never bakes a numeric uid into the default owner', () => {
    const p = planCarryEntry(entry({}))!;
    expect(p.chownArgs.join(' ')).not.toMatch(/\d/);
  });

  it('emits chownArgs free of shell metacharacters (both apply sites join them raw)', () => {
    for (const e of [entry({}), entry({ user: 0 }), entry({ user: 33 })]) {
      for (const tok of planCarryEntry(e)!.chownArgs) {
        expect(tok).not.toMatch(/[$`"'\\ ;&|<>()]/);
      }
    }
  });

  it('leaves absolute (non-~) dests untouched', () => {
    const p = planCarryEntry(entry({ absDest: '/etc/agentbox/x' }))!;
    expect(p.boxDest).toBe('/etc/agentbox/x');
    expect(p.parentDir).toBe('/etc/agentbox');
  });

  it('honors explicit user:0 (root) without turning it into the default', () => {
    expect(planCarryEntry(entry({ user: 0 }))!.chownArgs).toEqual(['0:0']);
    expect(planCarryEntry(entry({ user: 33 }))!.chownArgs).toEqual(['33:33']);
    // An explicit 1000 stays a literal uid — it does NOT mean "the box user".
    expect(planCarryEntry(entry({ user: 1000 }))!.chownArgs).toEqual(['1000:1000']);
  });

  it('renders mode as a zero-padded octal string (undefined when unset)', () => {
    expect(planCarryEntry(entry({ mode: 0o600 }))!.mode).toBe('0600');
    expect(planCarryEntry(entry({ mode: 0o755 }))!.mode).toBe('0755');
    expect(planCarryEntry(entry({}))!.mode).toBeUndefined();
  });

  it('flags rename when the file dest basename differs from the source', () => {
    const same = planCarryEntry(
      entry({ absSrc: '/host/a/marker.txt', absDest: '~/dir/marker.txt' }),
    )!;
    expect(same.renameNeeded).toBe(false);
    expect(same.fileBase).toBe('marker.txt');
    expect(same.destBase).toBe('marker.txt');

    const renamed = planCarryEntry(entry({ absSrc: '/host/a/src.txt', absDest: '~/dir/dst.txt' }))!;
    expect(renamed.renameNeeded).toBe(true);
    expect(renamed.fileBase).toBe('src.txt');
    expect(renamed.destBase).toBe('dst.txt');
  });

  it('treats dirs specially: parentDir is the dest, exclude carries through, no rename', () => {
    const p = planCarryEntry(
      entry({ kind: 'dir', absDest: '~/.config/app', exclude: ['node_modules', '.git'] }),
    )!;
    expect(p.isDir).toBe(true);
    expect(p.parentDir).toBe('/home/vscode/.config/app');
    expect(p.exclude).toEqual(['node_modules', '.git']);
    expect(p.renameNeeded).toBe(false);
    expect(p.fileBase).toBe('');
    expect(p.destBase).toBe('');
  });

  it('ignores exclude for file entries', () => {
    const p = planCarryEntry(entry({ kind: 'file', exclude: ['x'] }))!;
    expect(p.exclude).toEqual([]);
  });

  it('strips a trailing slash from a dir dest when computing parentDir', () => {
    const p = planCarryEntry(entry({ kind: 'dir', absDest: '~/.config/app/' }))!;
    expect(p.parentDir).toBe('/home/vscode/.config/app');
  });

  it('needs the parent chain for a dest nested under $HOME', () => {
    expect(planCarryEntry(entry({ absDest: '~/.agentbox/creds.json' }))!.parentChainNeeded).toBe(
      true,
    );
    // Immediate child of $HOME → parent is $HOME itself → nothing to walk.
    expect(planCarryEntry(entry({ kind: 'dir', absDest: '~/foo' }))!.parentChainNeeded).toBe(false);
    // Outside $HOME → system parents left alone.
    expect(planCarryEntry(entry({ absDest: '/etc/agentbox/x' }))!.parentChainNeeded).toBe(false);
  });
});
