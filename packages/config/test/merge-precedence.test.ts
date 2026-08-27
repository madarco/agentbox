import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEffectiveConfig } from '../src/load.js';
import { GLOBAL_CONFIG_FILE, projectConfigFile } from '../src/paths.js';
import { resetTempAgentboxHome } from '../../../scripts/test-home.js';

let tmpCwd: string;

beforeEach(async () => {
  // realpath so projectConfigFile(tmpCwd) hashes the same canonical path that
  // loadEffectiveConfig → findProjectRoot resolves to.
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-merge-')));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  // Wipe the per-file temp HOME between tests.
  await resetTempAgentboxHome();
});

async function writeYamlAt(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
}

describe('layered merge precedence', () => {
  it('built-in default applies when nothing else is set', async () => {
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.engine.kind).toBe('auto');
    expect(r.sources['engine.kind']).toBe('default');
  });

  it('global beats default', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'engine:\n  kind: orbstack\n');
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.engine.kind).toBe('orbstack');
    expect(r.sources['engine.kind']).toBe('global');
  });

  it('project beats global', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'engine:\n  kind: orbstack\n');
    await writeYamlAt(projectConfigFile(tmpCwd), 'engine:\n  kind: docker-desktop\n');
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.engine.kind).toBe('docker-desktop');
    expect(r.sources['engine.kind']).toBe('project');
  });

  it('workspace beats project (when agentbox.yaml is present)', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'engine:\n  kind: orbstack\n');
    await writeYamlAt(projectConfigFile(tmpCwd), 'engine:\n  kind: docker-desktop\n');
    await writeFile(
      join(tmpCwd, 'agentbox.yaml'),
      'defaults:\n  engine:\n    kind: other\n',
      'utf8',
    );
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.engine.kind).toBe('other');
    expect(r.sources['engine.kind']).toBe('workspace');
  });

  it('cli beats every file layer', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'engine:\n  kind: orbstack\n');
    await writeYamlAt(projectConfigFile(tmpCwd), 'engine:\n  kind: docker-desktop\n');
    await writeFile(
      join(tmpCwd, 'agentbox.yaml'),
      'defaults:\n  engine:\n    kind: other\n',
      'utf8',
    );
    const r = await loadEffectiveConfig(tmpCwd, {
      cliOverrides: { engine: { kind: 'auto' } },
    });
    expect(r.effective.engine.kind).toBe('auto');
    expect(r.sources['engine.kind']).toBe('cli');
  });

  it('merge is per-leaf — unrelated keys cascade independently', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'box:\n  withPlaywright: true\n  vnc: false\n');
    await writeYamlAt(projectConfigFile(tmpCwd), 'box:\n  vnc: true\n');
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.box.withPlaywright).toBe(true);
    expect(r.sources['box.withPlaywright']).toBe('global');
    expect(r.effective.box.vnc).toBe(true);
    expect(r.sources['box.vnc']).toBe('project');
  });

  it('a non-agentbox.yaml workspace layer is skipped without crashing', async () => {
    await writeYamlAt(projectConfigFile(tmpCwd), 'engine:\n  kind: docker-desktop\n');
    // tmpCwd has no agentbox.yaml — workspace layer is null.
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.layers.workspace.path).toBeNull();
    expect(r.layers.workspace.values).toEqual({});
    expect(r.effective.engine.kind).toBe('docker-desktop');
  });

  // Nested 3-level path (branch.subbranch.leaf) — the parser, merger, and
  // writer all needed teaching to walk dotted leaves. Worth its own cascade
  // test so a future refactor doesn't silently regress the tools
  // surface.
  it('tools.gh.enabled defaults to true (gh is the one built-in grant)', async () => {
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.tools.gh.enabled).toBe(true);
    expect(r.sources['tools.gh.enabled']).toBe('default');
  });

  it('tools.request.enabled defaults to true', async () => {
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.effective.tools.request.enabled).toBe(true);
    expect(r.sources['tools.request.enabled']).toBe('default');
  });

  it('tools.gh.enabled cascades global → project → cli', async () => {
    await writeYamlAt(GLOBAL_CONFIG_FILE, 'tools:\n  gh:\n    enabled: false\n');
    const fromGlobal = await loadEffectiveConfig(tmpCwd);
    expect(fromGlobal.effective.tools.gh.enabled).toBe(false);
    expect(fromGlobal.sources['tools.gh.enabled']).toBe('global');

    await writeYamlAt(projectConfigFile(tmpCwd), 'tools:\n  gh:\n    enabled: true\n');
    const fromProject = await loadEffectiveConfig(tmpCwd);
    expect(fromProject.effective.tools.gh.enabled).toBe(true);
    expect(fromProject.sources['tools.gh.enabled']).toBe('project');

    const fromCli = await loadEffectiveConfig(tmpCwd, {
      cliOverrides: { tools: { gh: { enabled: false } } },
    });
    expect(fromCli.effective.tools.gh.enabled).toBe(false);
    expect(fromCli.sources['tools.gh.enabled']).toBe('cli');
  });
});
