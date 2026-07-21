import { describe, expect, it } from 'vitest';
import {
  codexAddUrl,
  defaultHerdrSocketPath,
  detectOpenTargets,
  IDE_PROVIDERS,
  PERSISTENT_SSH_PROVIDERS,
  SSH_MOUNT_PROVIDERS,
  pathHasBinary,
  renderTargets,
  resolveCmuxBinary,
  resolveVscodeCli,
  type DetectSeams,
} from '../src/commands/_open-in.js';

function seams(overrides: {
  platform?: NodeJS.Platform;
  path?: string;
  env?: NodeJS.ProcessEnv;
  existing?: string[];
}): DetectSeams {
  const existing = new Set(overrides.existing ?? []);
  return {
    env: { PATH: overrides.path ?? '', ...overrides.env },
    platform: overrides.platform ?? 'darwin',
    homedir: () => '/home/u',
    existsSync: (p: string) => existing.has(p),
  };
}

describe('pathHasBinary', () => {
  it('finds a binary in a PATH dir', () => {
    const s = seams({ path: '/usr/bin:/opt/x/bin', existing: ['/opt/x/bin/herdr'] });
    expect(pathHasBinary('herdr', s)).toBe(true);
  });

  it('is false with an empty or missing PATH', () => {
    expect(pathHasBinary('code', seams({ path: '' }))).toBe(false);
    const s = seams({});
    delete s.env['PATH'];
    expect(pathHasBinary('code', s)).toBe(false);
  });
});

describe('detectOpenTargets', () => {
  it('detects claude via the app bundle on darwin only, gated to persistent-SSH providers', () => {
    const mac = seams({ existing: ['/Applications/Claude.app'] });
    expect(detectOpenTargets(mac).claude).toEqual({
      available: true,
      providers: [...PERSISTENT_SSH_PROVIDERS],
    });
    const home = seams({ existing: ['/home/u/Applications/Claude.app'] });
    expect(detectOpenTargets(home).claude.available).toBe(true);
    const linux = seams({ platform: 'linux', existing: ['/Applications/Claude.app'] });
    expect(detectOpenTargets(linux).claude.available).toBe(false);
    expect(detectOpenTargets(seams({})).claude.available).toBe(false);
  });

  it('detects codex via /Applications on darwin only', () => {
    const mac = seams({ existing: ['/Applications/Codex.app'] });
    expect(detectOpenTargets(mac).codex).toEqual({
      available: true,
      providers: [...PERSISTENT_SSH_PROVIDERS],
    });
    const linux = seams({ platform: 'linux', existing: ['/Applications/Codex.app'] });
    expect(detectOpenTargets(linux).codex.available).toBe(false);
  });

  it('detects codex via ~/Applications', () => {
    const s = seams({ existing: ['/home/u/Applications/Codex.app'] });
    expect(detectOpenTargets(s).codex.available).toBe(true);
  });

  it('detects herdr via PATH or the well-known socket', () => {
    const viaPath = seams({ path: '/bin', existing: ['/bin/herdr'] });
    expect(detectOpenTargets(viaPath).herdr).toEqual({ available: true });
    const viaSocket = seams({ existing: ['/home/u/.config/herdr/herdr.sock'] });
    expect(detectOpenTargets(viaSocket).herdr.available).toBe(true);
    expect(detectOpenTargets(seams({})).herdr.available).toBe(false);
  });

  it('detects herdr socket on linux too', () => {
    const s = seams({ platform: 'linux', existing: ['/home/u/.config/herdr/herdr.sock'] });
    expect(detectOpenTargets(s).herdr.available).toBe(true);
  });

  it('detects cmux via PATH or the app bundle', () => {
    const viaPath = seams({ platform: 'linux', path: '/bin', existing: ['/bin/cmux'] });
    expect(detectOpenTargets(viaPath).cmux.available).toBe(true);
    const viaApp = seams({ existing: ['/Applications/cmux.app'] });
    expect(detectOpenTargets(viaApp).cmux.available).toBe(true);
    expect(detectOpenTargets(seams({})).cmux.available).toBe(false);
  });

  it('detects vscode via code or cursor on PATH', () => {
    const viaCode = seams({ path: '/bin', existing: ['/bin/code'] });
    expect(detectOpenTargets(viaCode).vscode).toEqual({
      available: true,
      providers: [...IDE_PROVIDERS],
    });
    const viaCursor = seams({ platform: 'linux', path: '/bin', existing: ['/bin/cursor'] });
    expect(detectOpenTargets(viaCursor).vscode.available).toBe(true);
    expect(detectOpenTargets(seams({})).vscode.available).toBe(false);
  });

  it('detects vscode via the .app bundle when no PATH shim (fresh install)', () => {
    const viaCode = seams({ existing: ['/Applications/Visual Studio Code.app'] });
    expect(detectOpenTargets(viaCode).vscode.available).toBe(true);
    const viaCursor = seams({ existing: ['/home/u/Applications/Cursor.app'] });
    expect(detectOpenTargets(viaCursor).vscode.available).toBe(true);
    // The bundle is a macOS-only concept — Linux still needs the PATH binary.
    const linux = seams({ platform: 'linux', existing: ['/Applications/Visual Studio Code.app'] });
    expect(detectOpenTargets(linux).vscode.available).toBe(false);
  });

  it('detects iterm2 via the app bundle on darwin only', () => {
    const mac = seams({ existing: ['/Applications/iTerm.app'] });
    expect(detectOpenTargets(mac).iterm2).toEqual({ available: true });
    const home = seams({ existing: ['/home/u/Applications/iTerm.app'] });
    expect(detectOpenTargets(home).iterm2.available).toBe(true);
    const linux = seams({ platform: 'linux', existing: ['/Applications/iTerm.app'] });
    expect(detectOpenTargets(linux).iterm2.available).toBe(false);
    expect(detectOpenTargets(seams({})).iterm2.available).toBe(false);
  });

  it('finder requires sshfs on PATH, gated to SSH-mount providers', () => {
    const withSshfs = seams({ path: '/usr/local/bin', existing: ['/usr/local/bin/sshfs'] });
    expect(detectOpenTargets(withSshfs).finder).toEqual({
      available: true,
      providers: [...SSH_MOUNT_PROVIDERS],
    });
    // sshfs is cross-platform — PATH presence is the gate on linux too.
    const linux = seams({ platform: 'linux', path: '/usr/bin', existing: ['/usr/bin/sshfs'] });
    expect(detectOpenTargets(linux).finder.available).toBe(true);
    // Without sshfs the mount (and so `open --in finder`) fails — report why.
    const without = detectOpenTargets(seams({})).finder;
    expect(without.available).toBe(false);
    expect(without.reason).toContain('sshfs');
    expect(without.reason).toContain('brew install macfuse sshfs');
  });

  it('unavailable targets carry a reason; available ones omit it', () => {
    const bare = detectOpenTargets(seams({}));
    for (const info of Object.values(bare)) {
      expect(info.available).toBe(false);
      expect(info.reason).toBeTruthy();
    }
    const installed = detectOpenTargets(
      seams({ path: '/bin', existing: ['/Applications/Claude.app', '/bin/sshfs'] }),
    );
    expect(installed.claude.reason).toBeUndefined();
    expect(installed.finder.reason).toBeUndefined();
  });

  it('never throws on linux (no /Applications probes)', () => {
    expect(() => detectOpenTargets(seams({ platform: 'linux' }))).not.toThrow();
  });
});

describe('provider eligibility constants', () => {
  it('codex/persistent-ssh covers docker + hetzner + remote-docker; vscode covers docker + ssh clouds', () => {
    expect(PERSISTENT_SSH_PROVIDERS).toEqual(['docker', 'hetzner', 'remote-docker']);
    expect(IDE_PROVIDERS).toEqual(['docker', 'hetzner', 'daytona', 'remote-docker']);
  });

  it('open sshfs-mounts docker + hetzner + daytona + remote-docker; vercel/e2b excluded (no SSH)', () => {
    expect(SSH_MOUNT_PROVIDERS).toEqual(['docker', 'hetzner', 'daytona', 'remote-docker']);
    expect(SSH_MOUNT_PROVIDERS).not.toContain('vercel');
    expect(SSH_MOUNT_PROVIDERS).not.toContain('e2b');
  });
});

describe('codexAddUrl', () => {
  it('encodes the alias', () => {
    expect(codexAddUrl('my box+1')).toBe(
      'codex://settings/connections/ssh/add?name=my%20box%2B1',
    );
    expect(codexAddUrl('smoke')).toBe('codex://settings/connections/ssh/add?name=smoke');
  });
});

describe('resolveCmuxBinary', () => {
  it('prefers the env override', () => {
    const s = seams({ env: { CMUX_BUNDLED_CLI_PATH: '/custom/cmux' }, path: '/bin', existing: ['/bin/cmux'] });
    expect(resolveCmuxBinary(s)).toBe('/custom/cmux');
  });

  it('falls back to PATH, then the app bundle, then undefined', () => {
    const viaPath = seams({ path: '/bin', existing: ['/bin/cmux'] });
    expect(resolveCmuxBinary(viaPath)).toBe('cmux');
    const viaApp = seams({ existing: ['/Applications/cmux.app/Contents/Resources/bin/cmux'] });
    expect(resolveCmuxBinary(viaApp)).toBe('/Applications/cmux.app/Contents/Resources/bin/cmux');
    expect(resolveCmuxBinary(seams({}))).toBeUndefined();
    const linux = seams({
      platform: 'linux',
      existing: ['/Applications/cmux.app/Contents/Resources/bin/cmux'],
    });
    expect(resolveCmuxBinary(linux)).toBeUndefined();
  });

  it('resolves a ~/Applications bundle (matches detectOpenTargets availability)', () => {
    const viaHome = seams({
      existing: ['/home/u/Applications/cmux.app/Contents/Resources/bin/cmux'],
    });
    expect(resolveCmuxBinary(viaHome)).toBe(
      '/home/u/Applications/cmux.app/Contents/Resources/bin/cmux',
    );
  });
});

describe('resolveVscodeCli', () => {
  it('prefers the PATH shim', () => {
    const s = seams({ path: '/usr/local/bin', existing: ['/usr/local/bin/code'] });
    expect(resolveVscodeCli('code', s)).toBe('code');
  });

  it('falls back to the .app bundle CLI on darwin', () => {
    const appCli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    const s = seams({ existing: [appCli] });
    expect(resolveVscodeCli('code', s)).toBe(appCli);

    const cursorCli = '/home/u/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
    const sc = seams({ existing: [cursorCli] });
    expect(resolveVscodeCli('cursor', sc)).toBe(cursorCli);
  });

  it('is undefined with no PATH shim and no bundle, or on linux', () => {
    expect(resolveVscodeCli('code', seams({}))).toBeUndefined();
    const linux = seams({
      platform: 'linux',
      existing: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
    });
    expect(resolveVscodeCli('code', linux)).toBeUndefined();
  });
});

describe('defaultHerdrSocketPath', () => {
  it('returns the socket only when it exists', () => {
    const s = seams({ existing: ['/home/u/.config/herdr/herdr.sock'] });
    expect(defaultHerdrSocketPath(s)).toBe('/home/u/.config/herdr/herdr.sock');
    expect(defaultHerdrSocketPath(seams({}))).toBeUndefined();
  });
});

describe('renderTargets', () => {
  it('renders one line per app with provider scope', () => {
    const out = renderTargets({
      claude: { available: true, providers: ['docker', 'hetzner'] },
      codex: { available: false, providers: ['hetzner'] },
      herdr: { available: true },
      cmux: { available: true },
      vscode: { available: true, providers: ['docker', 'hetzner', 'daytona'] },
      iterm2: { available: true },
      finder: {
        available: false,
        reason: 'sshfs is not installed',
        providers: ['docker', 'hetzner', 'daytona'],
      },
    });
    expect(out).toBe(
      'claude: available (docker, hetzner boxes)\n' +
        'codex: not installed\n' +
        'herdr: available\n' +
        'cmux: available\n' +
        'vscode: available (docker, hetzner, daytona boxes)\n' +
        'iterm2: available\n' +
        'finder: sshfs is not installed\n',
    );
  });
});
