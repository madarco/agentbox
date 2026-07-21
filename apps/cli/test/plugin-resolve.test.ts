import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePackage } from '../src/commands/plugin.js';

/**
 * A published provider package ships ESM-only exports
 * (`exports: { ".": { "import": "./dist/index.js" } }`) and does NOT export
 * `./package.json`. The old resolver asked Node's CJS conditional resolver for
 * `<name>/package.json`, which throws ERR_PACKAGE_PATH_NOT_EXPORTED — so
 * `agentbox plugin add <published-pkg>` failed for exactly the real-world case.
 * These tests pin the on-disk resolution that replaced it.
 */
describe('resolvePackage', () => {
  let root: string;
  const savedNodePath = process.env.NODE_PATH;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentbox-plugin-resolve-'));
    // NODE_PATH is one of the candidate resolution roots; point it at our fixtures.
    process.env.NODE_PATH = root;
  });

  afterEach(() => {
    if (savedNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = savedNodePath;
    rmSync(root, { recursive: true, force: true });
  });

  function writePkg(name: string, pkgJson: Record<string, unknown>) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkgJson }));
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const providerModule = {};');
    return dir;
  }

  it('resolves an ESM-only package whose exports do not include ./package.json', () => {
    const dir = writePkg('agentbox-provider-esm', {
      version: '1.2.3',
      main: './dist/index.js',
      exports: { '.': { import: './dist/index.js' } },
    });
    const resolved = resolvePackage('agentbox-provider-esm');
    expect(resolved.packageName).toBe('agentbox-provider-esm');
    expect(resolved.version).toBe('1.2.3');
    expect(resolved.entryPath).toBe(join(dir, 'dist', 'index.js'));
  });

  it('resolves a scoped package name', () => {
    const dir = writePkg('@acme/agentbox-provider', {
      version: '0.1.0',
      exports: { '.': { import: './dist/index.js' } },
    });
    const resolved = resolvePackage('@acme/agentbox-provider');
    expect(resolved.packageName).toBe('@acme/agentbox-provider');
    expect(resolved.entryPath).toBe(join(dir, 'dist', 'index.js'));
  });

  it('throws a helpful error for an uninstalled package', () => {
    expect(() => resolvePackage('agentbox-provider-not-installed')).toThrow(/install it first/);
  });
});
