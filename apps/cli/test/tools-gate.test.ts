import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate HOME to a throwaway dir BEFORE @agentbox/config is ever loaded — it
// captures STATE_DIR at module-eval time, and apps/cli has no vitest setup
// file. Without this, the grant writes below would land in the developer's
// real ~/.agentbox. Every @agentbox/config import in this file is therefore
// DYNAMIC and lives below this line.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-tools-gate-home-'));
process.env['HOME'] = TEST_HOME;

let projectRoot: string;

beforeEach(async () => {
  vi.resetModules();
  projectRoot = mkdtempSync(join(tmpdir(), 'agentbox-tools-gate-proj-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(join(TEST_HOME, '.agentbox'), { recursive: true, force: true });
});

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

async function writeYaml(text: string): Promise<void> {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'agentbox.yaml'), text, 'utf8');
}

async function granted(): Promise<string[]> {
  const { loadGrantedTools } = await import('@agentbox/config');
  const map = await loadGrantedTools(projectRoot, { includeBuiltins: false });
  return [...map.keys()].sort();
}

async function runGate(yes: boolean) {
  const { runToolsGate } = await import('../src/lib/tools-gate.js');
  return runToolsGate({ projectRoot, yes });
}

describe('agentbox.yaml tools: gate', () => {
  it('is a no-op when there is no agentbox.yaml', async () => {
    const r = await runGate(true);
    expect(r).toEqual({ granted: [], declined: [] });
    expect(await granted()).toEqual([]);
  });

  it('is a no-op when the yaml has no tools: block', async () => {
    await writeYaml('tasks:\n  install:\n    command: echo hi\n');
    const r = await runGate(true);
    expect(r.granted).toEqual([]);
  });

  it('--yes grants the requested tools', async () => {
    await writeYaml('tools:\n  - terraform\n  - aws\n');
    const r = await runGate(true);
    expect(r.granted.sort()).toEqual(['aws', 'terraform']);
    expect(await granted()).toEqual(['aws', 'terraform']);
  });

  it('carries per-tool options through to the grant', async () => {
    await writeYaml(
      "tools:\n  aws:\n    bin: awscli\n    allow: ['^s3 ls']\n    deny: ['^s3 rm']\n    timeoutMs: 300000\n",
    );
    await runGate(true);
    const { loadGrantedTools } = await import('@agentbox/config');
    const g = (await loadGrantedTools(projectRoot)).get('aws');
    expect(g).toMatchObject({
      bin: 'awscli',
      allow: ['^s3 ls'],
      deny: ['^s3 rm'],
      timeoutMs: 300000,
      source: 'yaml',
    });
  });

  it('is idempotent — a second create does not re-prompt for the same tools', async () => {
    await writeYaml('tools:\n  - terraform\n');
    await runGate(true);
    // `yes: false` would prompt if anything were still pending; it returns
    // early instead, which is what keeps a repeat create quiet.
    const second = await runGate(false);
    expect(second).toEqual({ granted: [], declined: [] });
  });

  // A malformed block is a project bug worth surfacing, but it must not stop
  // the box from being created.
  it('warns and grants nothing on a malformed block', async () => {
    await writeYaml("tools:\n  aws:\n    deny: ['([unclosed']\n");
    const r = await runGate(true);
    expect(r.granted).toEqual([]);
    expect(await granted()).toEqual([]);
  });

  it('grants nothing for a name that could escape the shim dir', async () => {
    await writeYaml('tools:\n  "../../evil": {}\n');
    const r = await runGate(true);
    expect(r.granted).toEqual([]);
  });
});
