import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addRcLine,
  cliInvocation,
  moveLegacyCloudflared,
  spawnEnvFor,
  stableNode,
  zshenvFile,
  ensureLauncher,
  envWithRunningNode,
  launcherDirOnPath,
  launcherPath,
  launcherTarget,
  rcHasLine,
  renderLauncher,
  shellRcFor,
} from '../src/lib/launcher.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'launcher-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeNpmInstall(root: string): { dist: string; script: string } {
  const pkg = join(root, 'lib', 'node_modules', '@madarco', 'agentbox');
  const dist = join(pkg, 'dist');
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(dist, 'index.js'), '');
  const script = join(pkg, 'bin', 'agentbox.js');
  writeFileSync(script, 'console.log("ran", process.argv.slice(2).join(" "))\n');
  return { dist, script };
}

describe('launcherTarget', () => {
  it('points at bin/agentbox.js of an npm global install, with the running node', () => {
    const { dist, script } = fakeNpmInstall(join(tmp, 'v22'));
    const t = launcherTarget({
      argv1: join(dist, 'index.js'),
      execPath: process.execPath,
      distDir: dist,
    });
    expect(t).toMatchObject({ node: process.execPath, script });
  });

  it('is null under Volta, which pins global packages itself', () => {
    const { dist } = fakeNpmInstall(join(tmp, '.volta', 'tools', 'image', 'packages', 'x'));
    expect(launcherTarget({ argv1: join(dist, 'index.js'), distDir: dist })).toBeNull();
  });

  it('is null for a source checkout, npx and pnpm', () => {
    for (const argv1 of [
      '/home/me/agentbox/apps/cli/dist/index.js',
      '/home/me/.npm/_npx/abc/node_modules/@madarco/agentbox/dist/index.js',
      '/home/me/.local/share/pnpm/global/5/node_modules/@madarco/agentbox/dist/index.js',
    ]) {
      expect(launcherTarget({ argv1, distDir: dirname(argv1) }), argv1).toBeNull();
    }
  });
});

describe('ensureLauncher', () => {
  it('writes an executable launcher once, and rewrites only on change', () => {
    const t = { node: '/n/a/bin/node', script: '/p/bin/agentbox.js' };
    expect(ensureLauncher(t, tmp)).toBe(true);
    expect(ensureLauncher(t, tmp)).toBe(false);
    const body = readFileSync(launcherPath(tmp), 'utf8');
    expect(body).toContain(`node='/n/a/bin/node'`);
    expect(ensureLauncher({ ...t, node: '/n/b/bin/node' }, tmp)).toBe(true);
    expect(readFileSync(launcherPath(tmp), 'utf8')).toContain(`node='/n/b/bin/node'`);
  });

  it('does not re-point at an older build while the newer install exists', () => {
    const a = fakeNpmInstall(join(tmp, 'a'));
    const b = fakeNpmInstall(join(tmp, 'b'));
    const home = join(tmp, 'home');
    ensureLauncher({ node: process.execPath, script: a.script, version: '0.40.0' }, home);
    expect(
      ensureLauncher({ node: process.execPath, script: b.script, version: '0.33.0' }, home),
    ).toBe(false);
    expect(readFileSync(launcherPath(home), 'utf8')).toContain(a.script);
    // Newer, or the recorded install gone: re-point.
    expect(
      ensureLauncher({ node: process.execPath, script: b.script, version: '0.41.0' }, home),
    ).toBe(true);
    rmSync(join(tmp, 'b'), { recursive: true, force: true });
    expect(
      ensureLauncher({ node: process.execPath, script: a.script, version: '0.33.0' }, home),
    ).toBe(true);
  });

  it('is a no-op without a target', () => {
    expect(ensureLauncher(null, tmp)).toBe(false);
  });
});

describe('the launcher script', () => {
  const run = (launcher: string, path: string) =>
    spawnSync('/bin/sh', [launcher, 'x', 'y z'], {
      encoding: 'utf8',
      env: { PATH: path, HOME: tmp },
    });
  const sysPath = `${dirname(process.execPath)}:/usr/bin:/bin`;

  it('execs the recorded node on the recorded script with the args', () => {
    const { script } = fakeNpmInstall(join(tmp, 'a'));
    ensureLauncher({ node: process.execPath, script }, tmp);
    // No node on PATH at all: it must not need one.
    const r = run(launcherPath(tmp), '/usr/bin:/bin');
    expect(r.stdout).toBe('ran x y z\n');
    expect(r.stderr).toBe('');
  });

  it('falls back to node on PATH with a warning when the recorded node is gone', () => {
    const { script } = fakeNpmInstall(join(tmp, 'a'));
    ensureLauncher({ node: join(tmp, 'gone', 'node'), script }, tmp);
    const r = run(launcherPath(tmp), sysPath);
    expect(r.stdout).toBe('ran x y z\n');
    expect(r.stderr).toMatch(/no longer exists; using node from PATH.*agentbox install/);
  });

  it('falls back to another agentbox on PATH when the install is gone, skipping itself', () => {
    ensureLauncher({ node: process.execPath, script: join(tmp, 'gone.js') }, tmp);
    const other = join(tmp, 'otherbin');
    mkdirSync(other);
    writeFileSync(join(other, 'agentbox'), '#!/bin/sh\necho other "$@"\n');
    chmodSync(join(other, 'agentbox'), 0o755);
    const r = run(launcherPath(tmp), `${dirname(launcherPath(tmp))}:${other}:/usr/bin:/bin`);
    expect(r.stdout).toBe('other x y z\n');
    expect(r.stderr).toMatch(/using .*otherbin\/agentbox/);
  });

  it('skips itself even when PATH spells its dir differently', () => {
    ensureLauncher({ node: process.execPath, script: join(tmp, 'gone.js') }, tmp);
    const dir = dirname(launcherPath(tmp));
    const r = run(launcherPath(tmp), `${dir}/:${dir}/../bin:/usr/bin:/bin`);
    expect(r.status).toBe(127);
  });

  it('runs dist/index.js when an older (pre-launcher) version was installed over it', () => {
    const { script } = fakeNpmInstall(join(tmp, 'a'));
    const pkg = dirname(dirname(script));
    rmSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'index.js'), 'console.log("legacy", process.argv[2])\n');
    ensureLauncher({ node: process.execPath, script }, tmp);
    const r = run(launcherPath(tmp), '/usr/bin:/bin');
    expect(r.stdout).toBe('legacy x\n');
    expect(r.stderr).toBe('');
  });

  it('skips a symlink or copy of the launcher elsewhere on PATH (no exec loop)', () => {
    ensureLauncher({ node: process.execPath, script: join(tmp, 'gone.js') }, tmp);
    const other = join(tmp, 'otherbin');
    const copy = join(tmp, 'copybin');
    mkdirSync(other);
    mkdirSync(copy);
    symlinkSync(launcherPath(tmp), join(other, 'agentbox'));
    writeFileSync(join(copy, 'agentbox'), readFileSync(launcherPath(tmp)));
    chmodSync(join(copy, 'agentbox'), 0o755);
    const r = spawnSync('/bin/sh', [launcherPath(tmp)], {
      encoding: 'utf8',
      env: { PATH: `${other}:${copy}:/usr/bin:/bin`, HOME: tmp },
      timeout: 5000,
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/Reinstall/);
  });

  it('stops after one hop when the fallback leads back to a launcher', () => {
    ensureLauncher({ node: process.execPath, script: join(tmp, 'gone.js') }, tmp);
    // An unmarked wrapper that re-runs the launcher: only the hop guard stops it.
    const other = join(tmp, 'wrapbin');
    mkdirSync(other);
    writeFileSync(join(other, 'agentbox'), `#!/bin/sh\nexec /bin/sh ${launcherPath(tmp)} "$@"\n`);
    chmodSync(join(other, 'agentbox'), 0o755);
    const r = spawnSync('/bin/sh', [launcherPath(tmp)], {
      encoding: 'utf8',
      env: { PATH: `${other}:/usr/bin:/bin`, HOME: tmp },
      timeout: 5000,
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/is a launcher too/);
  });

  it('says how to reinstall when nothing is left', () => {
    ensureLauncher({ node: process.execPath, script: join(tmp, 'gone.js') }, tmp);
    const r = run(launcherPath(tmp), `${dirname(launcherPath(tmp))}:/usr/bin:/bin`);
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/npm install -g @madarco\/agentbox/);
  });

  it('quotes paths with spaces and quotes', () => {
    const body = renderLauncher("/a b/it's/node", '/s');
    const out = execFileSync(
      '/bin/sh',
      ['-c', `${body.split('\n').slice(2, 3).join('')}; echo "$node"`],
      {
        encoding: 'utf8',
      },
    );
    expect(out).toBe("/a b/it's/node\n");
  });
});

describe('shell rc', () => {
  it('writes ~/.zshenv unless zsh really reads $ZDOTDIR/.zshenv', () => {
    const z = join(tmp, '.config', 'zsh');
    // ZDOTDIR set inside ~/.zshenv: zsh never reads $ZDOTDIR/.zshenv.
    writeFileSync(join(tmp, '.zshenv'), `export ZDOTDIR="$HOME/.config/zsh"\n`);
    expect(zshenvFile(tmp, z)).toBe(join(tmp, '.zshenv'));
    // ZDOTDIR from the environment, no ~/.zshenv: $ZDOTDIR/.zshenv it is.
    rmSync(join(tmp, '.zshenv'));
    expect(zshenvFile(tmp, z)).toBe(join(z, '.zshenv'));
    // A ZDOTDIR outside HOME (a scratch HOME inheriting the real one) is ignored.
    expect(zshenvFile(tmp, '/Users/real/.config/zsh')).toBe(join(tmp, '.zshenv'));
    expect(zshenvFile(tmp, undefined)).toBe(join(tmp, '.zshenv'));
  });

  it('picks the file per shell', () => {
    expect(shellRcFor('/bin/zsh', '/h', 'linux', {})?.file).toBe('/h/.zshenv');
    expect(shellRcFor('/bin/zsh', '/h', 'linux', { ZDOTDIR: '/z' })?.file).toBe('/h/.zshenv');
    expect(shellRcFor('/bin/bash', '/h', 'darwin')?.file).toBe('/h/.bash_profile');
    expect(shellRcFor('/usr/bin/bash', '/h', 'linux')?.file).toBe('/h/.bashrc');
    expect(shellRcFor('/usr/bin/fish', '/h')?.file).toBe('/h/.config/fish/config.fish');
    expect(shellRcFor('/bin/tcsh', '/h')).toBeNull();
    expect(shellRcFor('', '/h')).toBeNull();
  });

  it('adds the line once, on its own line', () => {
    const rc = shellRcFor('/bin/zsh', tmp, 'linux', {})!;
    writeFileSync(rc.file, 'export FOO=1');
    expect(addRcLine(rc)).toBe(true);
    expect(addRcLine(rc)).toBe(false);
    expect(readFileSync(rc.file, 'utf8')).toBe(`export FOO=1\n${rc.line}\n`);
    expect(rcHasLine(rc)).toBe(true);
  });

  it('on macOS bash, writes to the login file that already exists', () => {
    writeFileSync(join(tmp, '.profile'), 'export X=1\n');
    expect(shellRcFor('/bin/bash', tmp, 'darwin')?.file).toBe(join(tmp, '.profile'));
  });

  it('creates a missing fish config', () => {
    const rc = shellRcFor('/usr/bin/fish', tmp)!;
    expect(addRcLine(rc)).toBe(true);
    expect(readFileSync(rc.file, 'utf8')).toBe(`${rc.line}\n`);
  });

  it("appends the launcher dir, so the active Node's agentbox wins", () => {
    const rc = shellRcFor('/bin/zsh', tmp, 'linux', {})!;
    addRcLine(rc);
    const out = execFileSync(
      '/bin/sh',
      ['-c', `PATH=/nvm/v20/bin:/usr/bin:/bin; HOME=${tmp}; . ${rc.file}; echo "$PATH"`],
      { encoding: 'utf8' },
    );
    const parts = out.trim().split(':');
    expect(parts[0]).toBe('/nvm/v20/bin');
    expect(parts.at(-1)).toBe(join(tmp, '.agentbox', 'bin'));
    expect(shellRcFor('/usr/bin/fish', tmp)!.line).toContain('--append');
  });

  it('detects the dir on PATH', () => {
    expect(launcherDirOnPath({ PATH: `/x:${tmp}/.agentbox/bin:/y` }, tmp)).toBe(true);
    expect(launcherDirOnPath({ PATH: '/x:/y' }, tmp)).toBe(false);
  });
});

describe('envWithRunningNode', () => {
  it('puts the running node first on PATH, once', () => {
    const bin = dirname(process.execPath);
    const env = envWithRunningNode({ PATH: `/other/node/bin:${bin}:/opt/x/bin` });
    expect(env['PATH']).toBe(`${bin}:/other/node/bin:/opt/x/bin`);
  });
});

describe('spawnEnvFor', () => {
  it('moves the running node first for npm only', () => {
    const bin = dirname(process.execPath);
    const env = { PATH: `/stale/node/bin:/opt/x/bin` };
    expect(spawnEnvFor('npm', env)['PATH']?.split(':')[0]).toBe(bin);
    for (const cmd of ['pnpm', 'agentbox', '/usr/bin/git']) {
      expect(spawnEnvFor(cmd, env), cmd).toBe(env);
    }
  });
});

describe('stableNode', () => {
  it('prefers <brew>/opt/<formula>/bin/node for a keg-only Cellar node', () => {
    const brew = join(tmp, 'brew');
    const cellarBin = join(brew, 'Cellar', 'node@22', '22.12.0', 'bin');
    mkdirSync(cellarBin, { recursive: true });
    writeFileSync(join(cellarBin, 'node'), '');
    mkdirSync(join(brew, 'opt'), { recursive: true });
    symlinkSync(join(brew, 'Cellar', 'node@22', '22.12.0'), join(brew, 'opt', 'node@22'));
    // A custom npm prefix with no node next to it: only the opt path qualifies.
    const script = join(
      tmp,
      'npm-global',
      'lib',
      'node_modules',
      '@madarco',
      'agentbox',
      'bin',
      'agentbox.js',
    );
    expect(stableNode(join(cellarBin, 'node'), script)).toBe(
      join(brew, 'opt', 'node@22', 'bin', 'node'),
    );
  });

  it('keeps execPath when nothing stabler resolves to the same binary', () => {
    expect(stableNode(process.execPath, '/nowhere/lib/node_modules/x/bin/agentbox.js')).toBe(
      process.execPath,
    );
  });
});

describe('cliInvocation', () => {
  it('is the launcher alone when this is a global install that has one', () => {
    const t = { node: process.execPath, script: '/p/bin/agentbox.js' };
    ensureLauncher(t, tmp);
    expect(cliInvocation(t, tmp)).toEqual([launcherPath(tmp)]);
  });

  it('is node + entry otherwise', () => {
    expect(cliInvocation(null, tmp)).toEqual([process.execPath, process.argv[1] ?? 'agentbox']);
    const t = { node: process.execPath, script: '/p/bin/agentbox.js' };
    expect(cliInvocation(t, join(tmp, 'no-launcher'))[0]).toBe(process.execPath);
  });
});

describe('moveLegacyCloudflared', () => {
  it('moves a cached cloudflared out of the PATH dir', () => {
    mkdirSync(join(tmp, '.agentbox', 'bin'), { recursive: true });
    writeFileSync(join(tmp, '.agentbox', 'bin', 'cloudflared'), 'bin');
    moveLegacyCloudflared(tmp);
    expect(existsSync(join(tmp, '.agentbox', 'bin', 'cloudflared'))).toBe(false);
    expect(readFileSync(join(tmp, '.agentbox', 'cache', 'bin', 'cloudflared'), 'utf8')).toBe('bin');
  });
});
