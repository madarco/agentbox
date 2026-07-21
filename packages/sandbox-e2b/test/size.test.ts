import { describe, expect, it, vi } from 'vitest';
import { parseE2bSize } from '../src/prepare.js';

describe('parseE2bSize', () => {
  it('parses a valid cpu-memory spec into cpuCount + memoryMB (GB->MiB)', () => {
    expect(parseE2bSize('4-8')).toEqual({ cpuCount: 4, memoryMB: 8192 });
    expect(parseE2bSize('2-4')).toEqual({ cpuCount: 2, memoryMB: 4096 });
    expect(parseE2bSize('  1-2  ')).toEqual({ cpuCount: 1, memoryMB: 2048 });
  });

  it('accepts a third disk slot but ignores it with a warning', () => {
    const warn = vi.fn();
    expect(parseE2bSize('4-8-20', warn)).toEqual({ cpuCount: 4, memoryMB: 8192 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/disk/i);
  });

  it('returns undefined for empty / unset input (caller keeps its defaults)', () => {
    expect(parseE2bSize(undefined)).toBeUndefined();
    expect(parseE2bSize('')).toBeUndefined();
    expect(parseE2bSize('   ')).toBeUndefined();
  });

  it('throws on malformed specs', () => {
    expect(() => parseE2bSize('0-8')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('4')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('4-8-')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('a-b')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('4-0')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('1.5-8')).toThrow(/expected 'cpu-memory'/);
    expect(() => parseE2bSize('4-8-20-40')).toThrow(/expected 'cpu-memory'/);
  });

  it('does not warn for a plain 2-slot spec', () => {
    const warn = vi.fn();
    parseE2bSize('4-8', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
