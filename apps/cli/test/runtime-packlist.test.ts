/**
 * Guards on what `npm pack` actually puts in the tarball. Nothing here can be
 * caught by running the dev CLI: the dev tree reads runtime/ straight off disk,
 * where every file is present regardless of what npm would ship.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const runtime = join(import.meta.dirname, '..', 'runtime');

function findIgnoreFiles(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findIgnoreFiles(full, found);
    else if (entry.name === '.gitignore' || entry.name === '.npmignore') found.push(full);
  }
  return found;
}

describe('staged runtime/ packlist', () => {
  it('carries no .gitignore or .npmignore', () => {
    // npm-packlist honours an ignore file found ANYWHERE inside the package, so
    // one that rides along in copied build output silently subtracts files from
    // the tarball while the dev tree stays complete. 0.31.0 shipped this way:
    // Next's standalone output brought apps/hub/.gitignore (which lists
    // `/.next/`) into runtime/hub/apps/hub/, and the entire Next production
    // build was stripped — `agentbox hub` started and died with "Could not find
    // a production build in the '.next' directory". stage-runtime.mjs strips
    // these; this asserts it kept working.
    expect(findIgnoreFiles(runtime)).toEqual([]);
  });

  it('keeps the hub Next build, when the hub is staged at all', () => {
    const hub = join(runtime, 'hub', 'apps', 'hub');
    if (!existsSync(join(hub, 'server.js'))) return; // partial dev build, no build:standalone
    expect(existsSync(join(hub, '.next', 'BUILD_ID'))).toBe(true);
  });
});
