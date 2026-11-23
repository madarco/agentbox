import { afterEach, describe, expect, it, vi } from 'vitest';

const execa = vi.fn();
vi.mock('execa', () => ({ execa: (...a: unknown[]) => execa(...a) }));

const {
  detectSbx,
  installSbx,
  installSbxHint,
  isPnpmGlobal,
  isSbxBroken,
  isSbxOutdated,
  parseNodeMajor,
  parseSbxMajor,
  resetSbxCache,
  shebangNode,
  updateSbxHint,
} = await import('../src/sbx-cli.js');

afterEach(() => {
  execa.mockReset();
  resetSbxCache();
});

describe('sbx version gate', () => {
  it('parses the major from the CLI version output', () => {
    expect(parseSbxMajor('3.0.1')).toBe(3);
    expect(parseSbxMajor('sandbox/4.13.0 linux-x64 node-v26.8.2')).toBe(4);
    expect(parseSbxMajor('10.2')).toBe(10);
    expect(parseSbxMajor('')).toBeNull();
    expect(parseSbxMajor(undefined)).toBeNull();
  });

  it('flags anything below 4.x as outdated and leaves unparsable output alone', () => {
    expect(isSbxOutdated('3.0.1')).toBe(true);
    expect(isSbxOutdated('2.9.9')).toBe(true);
    expect(isSbxOutdated('4.0.0')).toBe(false);
    expect(isSbxOutdated('4.13.0')).toBe(false);
    expect(isSbxOutdated('weird')).toBe(false);
    expect(isSbxOutdated(undefined)).toBe(false);
  });

  it('an outdated sbx is broken only under Node 26+, and never on an unknown Node', () => {
    expect(isSbxBroken(true, 26)).toBe(true);
    expect(isSbxBroken(true, 27)).toBe(true);
    expect(isSbxBroken(true, 24)).toBe(false);
    expect(isSbxBroken(true, undefined)).toBe(false);
    expect(isSbxBroken(false, 26)).toBe(false);
  });

  it('reads the node a CLI script runs under from its shebang', () => {
    expect(shebangNode('#!/opt/node26/bin/node\nrequire("x")')).toBe('/opt/node26/bin/node');
    expect(shebangNode('#!/usr/bin/env node\n')).toBeUndefined();
    expect(shebangNode('#!/bin/sh\nexec node "$basedir/x"')).toBeUndefined();
    expect(parseNodeMajor('v26.13.1\n')).toBe(26);
    expect(parseNodeMajor('garbage')).toBeUndefined();
  });

  it('suggests pnpm for a pnpm global install and names the binary', () => {
    expect(isPnpmGlobal('/Users/me/Library/pnpm/sbx')).toBe(true);
    expect(isPnpmGlobal('/home/me/.local/share/pnpm/sbx')).toBe(true);
    expect(isPnpmGlobal('/usr/local/bin/sbx')).toBe(false);
    expect(installSbxHint({ path: '/Users/me/Library/pnpm/sbx' })).toBe(
      'pnpm add -g sandbox@latest',
    );
    expect(installSbxHint({ path: '/usr/local/bin/sbx' })).toBe('npm install -g sandbox@latest');
    expect(installSbxHint()).toBe('npm install -g sandbox@latest');
    expect(updateSbxHint({ path: '/Users/me/Library/pnpm/sbx' })).toBe(
      '`pnpm add -g sandbox@latest` (the CLI on PATH is /Users/me/Library/pnpm/sbx)',
    );
  });

  it('detectSbx reports an outdated install with the Node it runs on', async () => {
    execa.mockImplementation(async (cmd: string) =>
      cmd === 'sbx' ? { exitCode: 0, stdout: '3.0.1\n' } : { exitCode: 0, stdout: 'v26.1.0' },
    );
    await expect(detectSbx()).resolves.toMatchObject({
      installed: true,
      bin: 'sbx',
      version: '3.0.1',
      outdated: true,
      nodeMajor: 26,
      broken: true,
    });
  });

  it('detectSbx keeps an outdated sbx usable on Node 24', async () => {
    execa.mockImplementation(async (cmd: string) =>
      cmd === 'sbx' ? { exitCode: 0, stdout: '3.0.1' } : { exitCode: 0, stdout: 'v24.1.0' },
    );
    await expect(detectSbx()).resolves.toMatchObject({ outdated: true, broken: false });
  });

  it('detectSbx reports a current install as not outdated', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '4.13.0' });
    await expect(detectSbx()).resolves.toMatchObject({
      installed: true,
      outdated: false,
      broken: false,
    });
  });

  it('installSbx installs @latest with the package manager that owns the install', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    await expect(installSbx()).resolves.toBe(true);
    expect(execa).toHaveBeenCalledWith('npm', ['install', '-g', 'sandbox@latest'], {
      reject: false,
    });
    await expect(installSbx({ path: '/Users/me/Library/pnpm/sbx' })).resolves.toBe(true);
    expect(execa).toHaveBeenLastCalledWith('pnpm', ['add', '-g', 'sandbox@latest'], {
      reject: false,
    });
  });
});
