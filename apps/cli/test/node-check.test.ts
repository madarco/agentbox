import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_NODE, nodeSatisfies, nodeVersionProblem } from '../bin/node-check.js';

describe('bin node-version gate', () => {
  it('accepts the floor and anything newer', () => {
    expect(nodeVersionProblem(MIN_NODE)).toBeNull();
    expect(nodeVersionProblem('22.13.0')).toBeNull();
    expect(nodeVersionProblem('v24.1.0')).toBeNull();
    expect(nodeVersionProblem('23.0.0')).toBeNull();
  });

  it('rejects older Nodes with the found and needed versions and a fix', () => {
    for (const v of ['14.21.3', '20.10.0', '20.20.2', '22.5.0', '22.11.9']) {
      const msg = nodeVersionProblem(v);
      expect(msg, v).toContain(`Node.js ${v}`);
      expect(msg).toContain(MIN_NODE);
      expect(msg).toContain('nvm install 22');
      expect(msg).toContain('nodejs.org');
    }
  });

  it('compares numerically, not as strings', () => {
    expect(nodeSatisfies('22.100.0', '22.12.0')).toBe(true);
    expect(nodeSatisfies('100.0.0', '22.12.0')).toBe(true);
    expect(nodeSatisfies('9.0.0', '22.12.0')).toBe(false);
  });

  it('matches package.json engines.node', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE.replace(/\.0$/, '')}`);
  });

  // The gate must parse on the old Nodes it is there to turn away.
  it('uses no syntax newer than Node 14 can parse', () => {
    for (const f of ['node-check.js', 'agentbox.js']) {
      const src = readFileSync(new URL(`../bin/${f}`, import.meta.url), 'utf8').replace(
        /\/\/.*$/gm,
        '',
      );
      expect(src, f).not.toMatch(/\?\.|\?\?|\bawait\b|#[a-z]/);
    }
  });
});
