import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCloneIdentity } from '../lib/boxes/clone-render';

/** What the `/agentbox-identity` skill writes into the workspace's yaml. */
const YAML_WITH_RULES = `openclaw:
  logging:
    level: info

# agentbox:identity-rules
replacements:
  identity:
    - from: '\\bAda\\b'
      to: '{{AGENTBOX_BOX_NAME}}'
      regex: true
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-clone-render-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderCloneIdentity', () => {
  it('rewrites the source bot name through the identity rule-set', async () => {
    await writeFile(join(dir, 'agentbox.yaml'), YAML_WITH_RULES);
    await writeFile(join(dir, 'SOUL.md'), '# Ada\n\nAda is careful and terse.\n');

    const r = await renderCloneIdentity({ dir, paths: ['SOUL.md'], boxName: 'bea' });

    expect(r.rendered).toEqual(['SOUL.md']);
    expect(r.hadRules).toBe(true);
    expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('# bea\n\nbea is careful and terse.\n');
  });

  it('leaves a word that merely CONTAINS the name alone (the rule is anchored)', async () => {
    await writeFile(join(dir, 'agentbox.yaml'), YAML_WITH_RULES);
    await writeFile(join(dir, 'SOUL.md'), 'Ada uses Adafruit parts.\n');

    await renderCloneIdentity({ dir, paths: ['SOUL.md'], boxName: 'bea' });

    expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('bea uses Adafruit parts.\n');
  });

  it('substitutes {{AGENTBOX_BOX_NAME}} even with no rule-set declared', async () => {
    await writeFile(join(dir, 'agentbox.yaml'), 'openclaw:\n  logging:\n    level: info\n');
    await writeFile(join(dir, 'IDENTITY.md'), 'I am {{AGENTBOX_BOX_NAME}}.\n');

    const r = await renderCloneIdentity({ dir, paths: ['IDENTITY.md'], boxName: 'bea' });

    expect(r.hadRules).toBe(false);
    expect(r.rendered).toEqual(['IDENTITY.md']);
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toBe('I am bea.\n');
  });

  it('reports a declared file the export did not produce, rather than failing', async () => {
    await writeFile(join(dir, 'agentbox.yaml'), YAML_WITH_RULES);

    const r = await renderCloneIdentity({ dir, paths: ['SOUL.md', 'IDENTITY.md'], boxName: 'bea' });

    expect(r.rendered).toEqual([]);
    expect(r.skipped).toEqual(['SOUL.md', 'IDENTITY.md']);
  });

  it('survives a workspace with no agentbox.yaml at all', async () => {
    await writeFile(join(dir, 'SOUL.md'), 'Ada.\n');

    const r = await renderCloneIdentity({ dir, paths: ['SOUL.md'], boxName: 'bea' });

    expect(r.hadRules).toBe(false);
    expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('Ada.\n');
  });

  it('does not let a malformed replacements: block fail the clone', async () => {
    await writeFile(join(dir, 'agentbox.yaml'), 'replacements:\n  identity: "not a list"\n');
    await writeFile(join(dir, 'SOUL.md'), 'Ada.\n');
    const lines: string[] = [];

    const r = await renderCloneIdentity({
      dir,
      paths: ['SOUL.md'],
      boxName: 'bea',
      onLog: (l) => lines.push(l),
    });

    expect(r.hadRules).toBe(false);
    expect(lines.join('\n')).toMatch(/replacements/);
    expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('Ada.\n');
  });

  it('is a no-op when the agent declares no render paths', async () => {
    const r = await renderCloneIdentity({ dir, paths: [], boxName: 'bea' });
    expect(r).toEqual({ rendered: [], skipped: [], hadRules: false });
  });
});
