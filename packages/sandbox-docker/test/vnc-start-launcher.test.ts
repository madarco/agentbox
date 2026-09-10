/**
 * The desktop browser launcher that `agentbox-vnc-start` generates is embedded
 * in that script as ONE single-quoted `bash -c` argument. Nothing catches a
 * quoting mistake inside it at build time: the generated file is written by a
 * box at VNC-start, and `agentbox screen` backgrounds it to /dev/null, so a
 * broken launcher looks exactly like "the browser just did not open".
 *
 * 0.31.0 shipped that way — an apostrophe added to a comment inside the body
 * ("Playwright's") closed the quote, and the launcher became a syntax error
 * that died before drawing anything, on every provider.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(
  join(import.meta.dirname, '..', 'scripts', 'agentbox-vnc-start'),
  'utf8',
);

/** The launcher body: everything between the `-e bash -c '` opener and its closing quote. */
function launcherBody(): string {
  const open = "  -e bash -c '\n";
  const start = script.indexOf(open);
  expect(start, 'the -e bash -c opener moved; update this test').toBeGreaterThan(-1);
  const rest = script.slice(start + open.length);
  const end = rest.indexOf("\n' agentbox-open-browser");
  expect(end, 'the launcher body closer moved; update this test').toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('agentbox-vnc-start desktop launcher', () => {
  it('has no apostrophe in the single-quoted body', () => {
    const offenders = launcherBody()
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("'"));
    expect(offenders).toEqual([]);
  });

  it('is valid bash', () => {
    // `bash -n` on the body as bash itself would receive it from xterm.
    expect(() =>
      execFileSync('bash', ['-n', '-c', launcherBody()], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
