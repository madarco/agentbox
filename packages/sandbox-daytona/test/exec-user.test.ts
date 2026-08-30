import { describe, expect, it } from 'vitest';
import { BOX_USER, buildDaytonaExec } from '../src/backend.js';

/**
 * Daytona's SDK has no per-exec user, so `opts.user` is honoured with an
 * in-shell `sudo -u` (vercel's pattern). It matters because the two sandbox
 * classes land as different users: a `container` honours the image's
 * `USER vscode`, while a `linux-vm` — whose rootfs conversion drops image
 * metadata — execs as root with `HOME=/root`, where none of the seeded
 * credentials live.
 */
const VM = { sandboxClass: 'linux-vm' } as const;
const CONTAINER = { sandboxClass: 'container' } as const;

/**
 * Undo one level of POSIX single-quoting — the inner script is quoted twice
 * (each prelude value, then the whole inner for `bash -lc`), so asserting on the
 * escaped literal tests the escaping of the escaping. Decode instead and assert
 * on the script a shell would actually run.
 */
function innerScript(cmd: string): string {
  const m = /^sudo -n -u \S+ -H bash -lc '(.*)'$/s.exec(cmd);
  if (!m) throw new Error(`not a wrapped command: ${cmd}`);
  return m[1]!.replace(/'\\''/g, `'`);
}

describe('buildDaytonaExec — linux-vm drops to the box user', () => {
  it('defaults to the box user', () => {
    const p = buildDaytonaExec('echo hi', VM);
    expect(p.cmd).toMatch(/^sudo -n -u vscode -H bash -lc /);
    expect(BOX_USER).toBe('vscode');
  });

  it('folds cwd and env INSIDE the wrap, not into the SDK arguments', () => {
    const p = buildDaytonaExec('echo hi', VM, { cwd: '/workspace', env: { FOO: 'bar' } });
    // The SDK's own cwd/env would apply to the outer root shell and never reach
    // the dropped user — that is the whole reason they move inside.
    expect(p.cwd).toBeUndefined();
    expect(p.env).toBeUndefined();
    expect(innerScript(p.cmd)).toBe("cd '/workspace'\nexport FOO='bar'\necho hi");
  });

  it('quotes a cwd and env value containing a single quote', () => {
    const p = buildDaytonaExec('true', VM, { cwd: "/tmp/it's", env: { A: "x'y" } });
    expect(innerScript(p.cmd)).toBe("cd '/tmp/it'\\''s'\nexport A='x'\\''y'\ntrue");
  });

  // The key is interpolated bare into a string that runs as root.
  it('rejects an env name that could inject a command', () => {
    expect(() => buildDaytonaExec('true', VM, { env: { 'x;rm -rf /': '1' } })).toThrow(
      /invalid env var name/,
    );
  });
});

describe('buildDaytonaExec — cases that must NOT be wrapped', () => {
  it('leaves an explicit root request alone', () => {
    // Load-bearing for the bake: sudo is not setuid until the repair runs, so a
    // wrapped pre-repair step would deadlock (sudo cannot fix sudo).
    const p = buildDaytonaExec('docker info', VM, { user: 'root' });
    expect(p.cmd).toBe('docker info');
    expect(p.cmd).not.toContain('sudo');
  });

  it('passes cwd/env through to the SDK when not dropping', () => {
    const p = buildDaytonaExec('true', VM, { user: 'root', cwd: '/tmp', env: { A: 'b' } });
    expect(p.cwd).toBe('/tmp');
    expect(p.env).toEqual({ A: 'b' });
  });

  it('leaves the container class alone — it already execs as the box user', () => {
    const p = buildDaytonaExec('echo hi', CONTAINER);
    expect(p.cmd).toBe('echo hi');
  });

  it('treats an unknown class as a VM, matching pause()', () => {
    // The class is absent on records written before it existed and on the
    // keepalive loop's synthetic handles; the VM side is the one needing the
    // wrap, so undefined must fall there.
    expect(buildDaytonaExec('echo hi', {}).cmd).toMatch(/^sudo -n -u vscode -H/);
  });
});
