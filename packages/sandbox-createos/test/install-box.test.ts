import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('CreateOS runtime installer', () => {
  it('installs the Portless CLI used by project supervisor tasks', () => {
    const script = readFileSync(resolve(HERE, '../scripts/install-box.sh'), 'utf8');

    expect(script).toMatch(/npm_global install -g --force[^\n]*\bportless\b/);
  });
});
