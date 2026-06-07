import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { carryPlaceholderContext, renderCarryEntries } from '../src/carry-render.js';

const BOX = { name: 'optima-abc', id: 'box_abc', kind: 'docker', hostWorkspace: '/w', projectRoot: '/w' };

function fileEntry(absSrc: string, over: Partial<ResolvedCarryEntry> = {}): ResolvedCarryEntry {
  return {
    rawSrc: absSrc,
    rawDest: 'apps/.env',
    absSrc,
    absDest: 'apps/.env',
    kind: 'file',
    optional: false,
    ...over,
  };
}

describe('carryPlaceholderContext', () => {
  it('derives AGENTBOX_BOX_HOST from the name', () => {
    expect(carryPlaceholderContext(BOX).AGENTBOX_BOX_HOST).toBe('optima-abc.localhost');
  });
});

describe('renderCarryEntries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'carry-render-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes entries through untouched when none opt in', async () => {
    const src = join(dir, 'a');
    await writeFile(src, 'plain');
    const entries = [fileEntry(src)];
    const out = await renderCarryEntries(entries, BOX);
    expect(out).toBe(entries); // same array reference — no work done
  });

  it('renders env placeholders + rules into a temp file, repointing absSrc', async () => {
    const src = join(dir, '.env.prod');
    await writeFile(src, 'URL=https://optima.localhost\nBOX={{AGENTBOX_BOX_NAME}}\n');
    const [out] = await renderCarryEntries(
      [
        fileEntry(src, {
          replaceEnvs: true,
          replace: [{ from: 'optima.localhost', to: '{{AGENTBOX_BOX_HOST}}' }],
        }),
      ],
      BOX,
    );
    expect(out?.absSrc).not.toBe(src); // repointed at the rendered temp
    const rendered = await readFile(out!.absSrc, 'utf8');
    expect(rendered).toBe('URL=https://optima-abc.localhost\nBOX=optima-abc\n');
    // The original host file is untouched.
    expect(await readFile(src, 'utf8')).toContain('optima.localhost');
  });
});
