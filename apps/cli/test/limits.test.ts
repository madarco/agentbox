import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { parseMemoryToBytes, resolveLimits, type LimitFlags } from '../src/limits.js';

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// resolveLimits only reads memory/cpus/pidsLimit/disk off the box slice.
function box(
  over: Partial<Pick<EffectiveConfig['box'], 'memory' | 'cpus' | 'pidsLimit' | 'disk'>> = {},
): EffectiveConfig['box'] {
  return {
    memory: 0,
    cpus: 0,
    pidsLimit: 0,
    disk: '',
    ...over,
  } as unknown as EffectiveConfig['box'];
}

describe('parseMemoryToBytes', () => {
  it('treats a bare number as bytes (matches docker --memory)', () => {
    expect(parseMemoryToBytes('512')).toBe(512);
    expect(parseMemoryToBytes('0')).toBe(0);
  });

  it('applies b/k/m/g suffixes as binary multiples', () => {
    expect(parseMemoryToBytes('512b')).toBe(512);
    expect(parseMemoryToBytes('64k')).toBe(64 * 1024);
    expect(parseMemoryToBytes('512m')).toBe(512 * MIB);
    expect(parseMemoryToBytes('2g')).toBe(2 * GIB);
  });

  it('is case-insensitive on the unit', () => {
    expect(parseMemoryToBytes('2G')).toBe(2 * GIB);
    expect(parseMemoryToBytes('512M')).toBe(512 * MIB);
    expect(parseMemoryToBytes('64K')).toBe(64 * 1024);
  });

  it('tolerates surrounding whitespace and a trailing b (e.g. kb/mb/gb)', () => {
    expect(parseMemoryToBytes('  2g  ')).toBe(2 * GIB);
    expect(parseMemoryToBytes('512mb')).toBe(512 * MIB);
  });

  it('floors fractional results to whole bytes', () => {
    expect(parseMemoryToBytes('0.5k')).toBe(512);
    expect(parseMemoryToBytes('1.9')).toBe(1);
    expect(parseMemoryToBytes('1.5k')).toBe(Math.floor(1.5 * 1024));
  });

  it('throws on garbage, empty, and negative input', () => {
    expect(() => parseMemoryToBytes('abc')).toThrow(/invalid --memory/);
    expect(() => parseMemoryToBytes('')).toThrow(/invalid --memory/);
    expect(() => parseMemoryToBytes('   ')).toThrow(/invalid --memory/);
    expect(() => parseMemoryToBytes('-5')).toThrow(/invalid --memory/);
    expect(() => parseMemoryToBytes('12x')).toThrow(/invalid --memory/);
    expect(() => parseMemoryToBytes('.')).toThrow(/invalid --memory/);
  });
});

const NO_FLAGS: LimitFlags = {};

describe('resolveLimits — config only', () => {
  it('converts box.memory (MiB) to bytes and leaves the rest unlimited', () => {
    expect(resolveLimits(box({ memory: 2048 }), NO_FLAGS)).toEqual({
      memoryBytes: 2048 * MIB,
      cpus: null,
      pidsLimit: null,
      disk: null,
    });
  });

  it('treats 0 (and empty disk) as unlimited/null across the board', () => {
    expect(resolveLimits(box(), NO_FLAGS)).toEqual({
      memoryBytes: null,
      cpus: null,
      pidsLimit: null,
      disk: null,
    });
  });

  it('passes through box.cpus, box.pidsLimit, and box.disk', () => {
    expect(resolveLimits(box({ cpus: 4, pidsLimit: 512, disk: '10G' }), NO_FLAGS)).toEqual({
      memoryBytes: null,
      cpus: 4,
      pidsLimit: 512,
      disk: '10G',
    });
  });
});

describe('resolveLimits — flags beat config', () => {
  it('lets --memory (with unit) override box.memory', () => {
    expect(resolveLimits(box({ memory: 1024 }), { memory: '2g' }).memoryBytes).toBe(2 * GIB);
  });

  it('accepts a fractional --cpus', () => {
    expect(resolveLimits(box({ cpus: 2 }), { cpus: '1.5' }).cpus).toBe(1.5);
  });

  it('lets --disk override box.disk (raw passthrough)', () => {
    expect(resolveLimits(box({ disk: '10G' }), { disk: '20G' }).disk).toBe('20G');
  });

  it('treats an explicit 0 flag as unlimited/null', () => {
    expect(resolveLimits(box({ cpus: 4 }), { cpus: '0' }).cpus).toBeNull();
    expect(resolveLimits(box({ pidsLimit: 512 }), { pidsLimit: '0' }).pidsLimit).toBeNull();
  });

  it('ignores an empty-string flag and falls back to config', () => {
    expect(resolveLimits(box({ cpus: 2 }), { cpus: '' }).cpus).toBe(2);
    expect(resolveLimits(box({ memory: 1024 }), { memory: '' }).memoryBytes).toBe(1024 * MIB);
  });
});

describe('resolveLimits — flag validation', () => {
  it('throws on a non-numeric or negative --cpus', () => {
    expect(() => resolveLimits(box(), { cpus: 'lots' })).toThrow(/invalid --cpus/);
    expect(() => resolveLimits(box(), { cpus: '-1' })).toThrow(/invalid --cpus/);
  });

  it('throws on a non-integer or negative --pids-limit', () => {
    expect(() => resolveLimits(box(), { pidsLimit: '1.5' })).toThrow(/invalid --pids-limit/);
    expect(() => resolveLimits(box(), { pidsLimit: '-1' })).toThrow(/invalid --pids-limit/);
    expect(() => resolveLimits(box(), { pidsLimit: 'abc' })).toThrow(/invalid --pids-limit/);
  });

  it('throws on a garbage --memory flag', () => {
    expect(() => resolveLimits(box(), { memory: 'huge' })).toThrow(/invalid --memory/);
  });
});
