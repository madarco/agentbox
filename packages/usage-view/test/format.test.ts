import { describe, expect, it } from 'vitest';
import { fmt, fmtLines } from '../src/components/format.js';

describe('fmt', () => {
  it('picks the unit from the rounded text', () => {
    expect(fmt(812)).toBe('812');
    expect(fmt(999.6)).toBe('1.0k');
    expect(fmt(1204)).toBe('1.2k');
    expect(fmt(9_999.6)).toBe('10k');
    expect(fmt(38_214)).toBe('38k');
    expect(fmt(999_999)).toBe('1.0M');
    expect(fmt(126.4e6)).toBe('126.4M');
    expect(fmt(999_990_000)).toBe('1.00B');
  });

  it('fmtLines keeps a decimal below 100k', () => {
    expect(fmtLines(38_214)).toBe('38.2k');
    expect(fmtLines(11_402)).toBe('11.4k');
    expect(fmtLines(99_960)).toBe('100k');
    expect(fmtLines(999_600)).toBe('1.0M');
  });
});
