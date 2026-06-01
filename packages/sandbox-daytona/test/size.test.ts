import { describe, expect, it } from 'vitest';
import { parseDaytonaSize } from '../src/backend.js';

describe('parseDaytonaSize', () => {
  it('parses a valid cpu-memory-disk spec', () => {
    expect(parseDaytonaSize('4-8-20')).toEqual({ cpu: 4, memory: 8, disk: 20 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDaytonaSize('  2-4-10  ')).toEqual({ cpu: 2, memory: 4, disk: 10 });
  });

  it('rejects missing parts', () => {
    expect(parseDaytonaSize('4-8')).toBeUndefined();
    expect(parseDaytonaSize('4')).toBeUndefined();
  });

  it('rejects non-integer or non-positive values', () => {
    expect(parseDaytonaSize('foo-8-20')).toBeUndefined();
    expect(parseDaytonaSize('0-8-20')).toBeUndefined();
    expect(parseDaytonaSize('-1-8-20')).toBeUndefined();
    expect(parseDaytonaSize('1.5-8-20')).toBeUndefined();
  });

  it('returns undefined for empty / undefined input', () => {
    expect(parseDaytonaSize(undefined)).toBeUndefined();
    expect(parseDaytonaSize('')).toBeUndefined();
  });
});
