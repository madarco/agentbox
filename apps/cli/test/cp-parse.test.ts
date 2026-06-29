import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/commands/cp.js';

// parseArgs is pure (no fs / no HOME access), so these stay unit-safe despite
// apps/cli tests sharing the real $HOME.

describe('cp parseArgs — direction + arity', () => {
  it('one box arg downloads into cwd', () => {
    const p = parseArgs(['mybox:/workspace/.env']);
    expect(p.direction).toBe('download');
    expect(p.boxRef).toBe('mybox');
    expect(p.boxSrcs).toEqual(['/workspace/.env']);
    expect(p.hostDst).toBeUndefined();
  });

  it('single download with explicit host dest', () => {
    const p = parseArgs(['mybox:/etc/foo', './foo']);
    expect(p.direction).toBe('download');
    expect(p.boxSrcs).toEqual(['/etc/foo']);
    expect(p.hostDst).toBe('./foo');
  });

  it('single upload (rename semantics preserved by single source)', () => {
    const p = parseArgs(['./local.txt', 'mybox:/workspace/x']);
    expect(p.direction).toBe('upload');
    expect(p.boxRef).toBe('mybox');
    expect(p.hostSrcs).toEqual(['./local.txt']);
    expect(p.boxDst).toBe('/workspace/x');
  });

  it('multiple upload sources, last arg is the dest', () => {
    const p = parseArgs(['a.txt', 'b.txt', 'src/', 'mybox:/workspace/dest/']);
    expect(p.direction).toBe('upload');
    expect(p.hostSrcs).toEqual(['a.txt', 'b.txt', 'src/']);
    expect(p.boxDst).toBe('/workspace/dest/');
  });

  it('multiple download sources from the same box', () => {
    const p = parseArgs(['mybox:/etc/hostname', 'mybox:/etc/hosts', './out/']);
    expect(p.direction).toBe('download');
    expect(p.boxRef).toBe('mybox');
    expect(p.boxSrcs).toEqual(['/etc/hostname', '/etc/hosts']);
    expect(p.hostDst).toBe('./out/');
  });
});

describe('cp parseArgs — errors', () => {
  it('rejects box-to-box copy', () => {
    expect(() => parseArgs(['a:/x', 'b:/y'])).toThrow(/box-to-box/);
  });

  it('rejects when neither side is a box path', () => {
    expect(() => parseArgs(['./a', './b'])).toThrow(/one side must be a box path/);
  });

  it('rejects mixed-side sources (box + host)', () => {
    expect(() => parseArgs(['mybox:/a', './b', './dest/'])).toThrow(/same side/);
  });

  it('rejects sources from different boxes', () => {
    expect(() => parseArgs(['a:/x', 'b:/y', './dest/'])).toThrow(/same box/);
  });

  it('requires a destination for host -> box upload', () => {
    expect(() => parseArgs(['./onlyhost'])).toThrow(/one side must be a box path/);
  });

  it('requires at least one path', () => {
    expect(() => parseArgs([])).toThrow(/at least one path/);
  });
});
