import { afterEach, describe, expect, it, vi } from 'vitest';

const execa = vi.fn();
vi.mock('execa', () => ({ execa: (...a: unknown[]) => execa(...a) }));

const { detectSbx, installSbx, isSbxOutdated, parseSbxMajor, resetSbxCache } =
  await import('../src/sbx-cli.js');

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

  it('detectSbx reports an outdated install', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '3.0.1\n' });
    await expect(detectSbx()).resolves.toEqual({
      installed: true,
      bin: 'sbx',
      version: '3.0.1',
      outdated: true,
    });
  });

  it('detectSbx reports a current install as not outdated', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '4.13.0' });
    await expect(detectSbx()).resolves.toMatchObject({ installed: true, outdated: false });
  });

  it('installSbx installs @latest so it also updates an old install', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    await expect(installSbx()).resolves.toBe(true);
    expect(execa).toHaveBeenCalledWith('npm', ['install', '-g', 'sandbox@latest'], {
      reject: false,
    });
  });
});
