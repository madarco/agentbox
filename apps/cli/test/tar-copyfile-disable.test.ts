import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: a `tar` that CREATES an archive from a host path must
 * pass `COPYFILE_DISABLE=1`.
 *
 * macOS BSD tar otherwise emits `._*` AppleDouble resource-fork stubs, and they
 * land wherever the archive is unpacked — a box's `/workspace`, a bake context,
 * an exported clone. This is not a theoretical rule: it has been fixed at call
 * site after call site, each time as a bug report from a real box
 * (`._agentbox.yaml`, `._AGENTS.md`, `._skills`), because the rule lived only in
 * the comments of the sites that already had it. This scan is what turns it
 * into a repo fact instead of a habit.
 *
 * Extractions (`-x`) are exempt — the variable means nothing when unpacking.
 *
 * A source scan rather than a lint rule for the same reason
 * `no-inline-agent-union.test.ts` is one: it is one rule about one repo fact,
 * and it must fail in the same `pnpm test` run that would otherwise pass.
 */
const REPO = join(__dirname, '..', '..', '..');

const ROOTS = [
  'apps/cli/src',
  'packages/core/src',
  'packages/ctl/src',
  'packages/relay/src',
  'packages/sandbox-core/src',
  'packages/sandbox-cloud/src',
  'packages/sandbox-docker/src',
  'packages/sandbox-remote-docker/src',
  'packages/sandbox-hetzner/src',
  'packages/sandbox-digitalocean/src',
];

/** A create flag: `-c`, `-cf`, `-czf`, `-cvf`… but never `-x…`. */
const CREATE_FLAG = /'-[a-zA-Z]*c[a-zA-Z]*'/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `execa('tar', …)` call site, as (file, line, call text). */
function tarCalls(): { file: string; line: number; call: string }[] {
  const out: { file: string; line: number; call: string }[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      const src = readFileSync(file, 'utf8');
      const re = /execa\(\s*'tar'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // Enough of the call to cover its options object; these are short.
        const seg = src.slice(m.index, m.index + 800);
        const end = seg.indexOf('});');
        out.push({
          file: file.slice(REPO.length + 1),
          line: src.slice(0, m.index).split('\n').length,
          call: end === -1 ? seg.slice(0, 400) : seg.slice(0, end + 3),
        });
      }
    }
  }
  return out;
}

describe('tar invocations', () => {
  const calls = tarCalls();

  it('finds the tar call sites at all (guards the scanner itself)', () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it('every archive-CREATING tar disables macOS AppleDouble stubs', () => {
    const offenders = calls
      .filter((c) => CREATE_FLAG.test(c.call))
      .filter((c) => !c.call.includes('COPYFILE_DISABLE') && !c.call.includes('HOST_TAR_ENV'))
      .map((c) => `${c.file}:${String(c.line)}`);
    expect(
      offenders,
      `add \`env: { ...process.env, COPYFILE_DISABLE: '1' }\` to:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
