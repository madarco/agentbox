import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot } from '../src/paths.js';
import { rm } from 'node:fs/promises';

let tmp: string;

beforeEach(async () => {
  // realpath so the test's expected `resolve(tmp)` value matches what
  // findProjectRoot returns after canonicalising symlinks like macOS's /var.
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-find-')));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('returns cwd when no agentbox.yaml ancestor exists', async () => {
    const r = await findProjectRoot(tmp);
    expect(r.root).toBe(tmp);
    expect(r.hasAgentboxYaml).toBe(false);
  });

  it('finds agentbox.yaml in the same directory', async () => {
    await writeFile(join(tmp, 'agentbox.yaml'), '');
    const r = await findProjectRoot(tmp);
    expect(r.root).toBe(tmp);
    expect(r.hasAgentboxYaml).toBe(true);
  });

  it('walks up from a nested cwd to the ancestor agentbox.yaml', async () => {
    const nested = join(tmp, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    await writeFile(join(tmp, 'agentbox.yaml'), '');
    const r = await findProjectRoot(nested);
    expect(r.root).toBe(tmp);
    expect(r.hasAgentboxYaml).toBe(true);
  });

  it('prefers the closest ancestor when multiple exist', async () => {
    const inner = join(tmp, 'inner');
    const innerNested = join(inner, 'nested');
    await mkdir(innerNested, { recursive: true });
    await writeFile(join(tmp, 'agentbox.yaml'), '');
    await writeFile(join(inner, 'agentbox.yaml'), '');
    const r = await findProjectRoot(innerNested);
    expect(r.root).toBe(inner);
  });

  it('does not match a directory named agentbox.yaml (only files)', async () => {
    await mkdir(join(tmp, 'agentbox.yaml'), { recursive: true });
    const r = await findProjectRoot(tmp);
    expect(r.hasAgentboxYaml).toBe(false);
  });
});
