import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_GH_GRANT,
  isValidToolName,
  loadGrantedTools,
  readToolsFile,
  removeToolGrant,
  writeToolGrant,
} from '../src/tools.js';
import { GLOBAL_TOOLS_FILE, projectToolsFile } from '../src/paths.js';

// The vitest setup file points HOME at a scratch dir, so GLOBAL_TOOLS_FILE
// and projectToolsFile() already resolve under it.
const tmpRoot = mkdtempSync(join(tmpdir(), 'agentbox-tools-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

async function writeYaml(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

describe('tool name validation', () => {
  it('accepts plain command names', () => {
    for (const n of ['gh', 'terraform', 'aws-cli', 'node_18', 'a.b+c']) {
      expect(isValidToolName(n)).toBe(true);
    }
  });

  // The name becomes a ~/.local/bin/<name> symlink inside the box, so a
  // path separator or a leading dash would be a real escape.
  it('rejects anything that is not a bare command name', () => {
    for (const n of ['../etc/passwd', 'a/b', '-rf', '', 'a b', 'x'.repeat(65)]) {
      expect(isValidToolName(n)).toBe(false);
    }
  });
});

describe('grant file round-trip', () => {
  beforeEach(async () => {
    await writeYaml(GLOBAL_TOOLS_FILE, 'tools: {}\n');
    await writeYaml(projectToolsFile(tmpRoot), 'tools: {}\n');
  });

  it('writes and reads a grant', async () => {
    const file = projectToolsFile(tmpRoot);
    await writeToolGrant(file, {
      name: 'terraform',
      bin: 'terraform',
      source: 'cli',
      allow: ['^plan$'],
      timeoutMs: 300_000,
    });
    const read = await readToolsFile(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      name: 'terraform',
      bin: 'terraform',
      allow: ['^plan$'],
      timeoutMs: 300_000,
    });
  });

  it('preserves siblings when writing another grant', async () => {
    const file = projectToolsFile(tmpRoot);
    await writeToolGrant(file, { name: 'terraform', bin: 'terraform', source: 'cli' });
    await writeToolGrant(file, { name: 'aws', bin: 'aws', source: 'request' });
    const names = (await readToolsFile(file)).map((g) => g.name);
    expect(names.sort()).toEqual(['aws', 'terraform']);
  });

  it('removes a grant and reports whether it was there', async () => {
    const file = projectToolsFile(tmpRoot);
    await writeToolGrant(file, { name: 'terraform', bin: 'terraform', source: 'cli' });
    await expect(removeToolGrant(file, 'terraform')).resolves.toBe(true);
    await expect(removeToolGrant(file, 'terraform')).resolves.toBe(false);
    expect(await readToolsFile(file)).toHaveLength(0);
  });

  it('defaults bin to the tool name', async () => {
    await writeYaml(projectToolsFile(tmpRoot), 'tools:\n  terraform:\n    source: cli\n');
    const read = await readToolsFile(projectToolsFile(tmpRoot));
    expect(read[0]?.bin).toBe('terraform');
  });
});

describe('fail-closed reads', () => {
  it('an absent file yields no grants', async () => {
    expect(await readToolsFile(join(tmpRoot, 'nope.yaml'))).toEqual([]);
  });

  it('malformed yaml yields no grants rather than throwing', async () => {
    const file = join(tmpRoot, 'bad.yaml');
    await writeYaml(file, 'tools: [unclosed\n');
    expect(await readToolsFile(file)).toEqual([]);
  });

  it('skips entries whose name could escape the shim dir', async () => {
    const file = join(tmpRoot, 'escape.yaml');
    await writeYaml(file, 'tools:\n  "../../evil": {}\n  ok: {}\n');
    expect((await readToolsFile(file)).map((g) => g.name)).toEqual(['ok']);
  });
});

describe('layering', () => {
  beforeEach(async () => {
    await writeYaml(GLOBAL_TOOLS_FILE, 'tools: {}\n');
    await writeYaml(projectToolsFile(tmpRoot), 'tools: {}\n');
  });

  it('includes the built-in gh grant', async () => {
    const grants = await loadGrantedTools(tmpRoot);
    expect(grants.get('gh')).toEqual(BUILTIN_GH_GRANT);
  });

  it('a global grant applies to every project', async () => {
    await writeYaml(GLOBAL_TOOLS_FILE, 'tools:\n  aws:\n    bin: aws\n    source: cli\n');
    const grants = await loadGrantedTools(tmpRoot);
    expect(grants.get('aws')?.bin).toBe('aws');
  });

  it('a project grant wins over a global one of the same name', async () => {
    await writeYaml(GLOBAL_TOOLS_FILE, 'tools:\n  aws:\n    bin: aws\n    source: cli\n');
    await writeYaml(
      projectToolsFile(tmpRoot),
      'tools:\n  aws:\n    bin: aws\n    source: cli\n    deny:\n      - "^s3 rm"\n',
    );
    const grants = await loadGrantedTools(tmpRoot);
    expect(grants.get('aws')?.deny).toEqual(['^s3 rm']);
  });

  it('opts.includeBuiltins=false leaves gh out (what the daemon symlinks from)', async () => {
    const grants = await loadGrantedTools(tmpRoot, { includeBuiltins: false });
    expect(grants.has('gh')).toBe(false);
  });
});
