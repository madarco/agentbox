import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeDashboardAttachArgv,
  buildClaudeLoginRunArgv,
  buildClaudeMounts,
  buildClaudeStatusBarArgs,
  formatDetachNotice,
  DEFAULT_CLAUDE_SESSION,
  resolveClaudeVolume,
  scanPluginCacheForRebuild,
  SHARED_CLAUDE_VOLUME,
} from '../src/claude.js';

describe('resolveClaudeVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolveClaudeVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_CLAUDE_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolveClaudeVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_CLAUDE_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildClaudeDashboardAttachArgv', () => {
  it('attaches via a grouped sibling session with the inner status bar off', () => {
    const argv = buildClaudeDashboardAttachArgv('agentbox-box1');
    const dash = `${DEFAULT_CLAUDE_SESSION}-dash`;
    // grouped session created (or no-op) before status is changed, attach last
    expect(argv).toEqual([
      'exec',
      '-it',
      '-e',
      `TERM=${process.env['TERM'] ?? 'xterm-256color'}`,
      '--user',
      'vscode',
      'agentbox-box1',
      'tmux',
      'new-session',
      '-A',
      '-d',
      '-s',
      dash,
      '-t',
      DEFAULT_CLAUDE_SESSION,
      ';',
      'set',
      '-t',
      dash,
      'status',
      'off',
      ';',
      'attach',
      '-t',
      dash,
    ]);
  });

  it('derives the grouped session from a custom session name', () => {
    const argv = buildClaudeDashboardAttachArgv('agentbox-box1', 'codex');
    expect(argv).toContain('codex');
    expect(argv).toContain('codex-dash');
    // never attaches directly to the original session (would show its footer)
    const attachIdx = argv.lastIndexOf('attach');
    expect(argv[attachIdx + 2]).toBe('codex-dash');
  });
});

describe('formatDetachNotice', () => {
  it('tells the user how to reattach by numeric index', () => {
    expect(formatDetachNotice('3')).toBe(
      'Session detached. Reattach with: agentbox claude attach 3',
    );
  });
  it('falls back to a box name ref', () => {
    expect(formatDetachNotice('my-box')).toBe(
      'Session detached. Reattach with: agentbox claude attach my-box',
    );
  });
});

describe('buildClaudeLoginRunArgv', () => {
  it('builds a throwaway docker run mounting the claude-config volume', () => {
    const argv = buildClaudeLoginRunArgv({
      volume: 'agentbox-claude-config',
      image: 'agentbox/box:dev',
      extraArgs: ['--sso'],
    });
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-it');
    expect(argv).toContain('-v');
    expect(argv).toContain('agentbox-claude-config:/home/vscode/.claude');
    expect(argv).toContain('agentbox/box:dev');
    expect(argv.slice(-4)).toEqual(['claude', 'auth', 'login', '--sso']);
  });

  it('blanks DISPLAY and runs as vscode', () => {
    const argv = buildClaudeLoginRunArgv({
      volume: 'v',
      image: 'img',
      extraArgs: [],
    });
    const i = argv.indexOf('DISPLAY=');
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe('-e');
    expect(argv).toContain('--user');
    expect(argv).toContain('vscode');
    expect(argv.slice(-3)).toEqual(['claude', 'auth', 'login']);
  });

  it('appends multiple extra args verbatim', () => {
    const argv = buildClaudeLoginRunArgv({
      volume: 'v',
      image: 'img',
      extraArgs: ['--console', '--email', 'a@b.c'],
    });
    expect(argv.slice(-6)).toEqual([
      'claude',
      'auth',
      'login',
      '--console',
      '--email',
      'a@b.c',
    ]);
  });
});

describe('buildClaudeStatusBarArgs', () => {
  it('remaps the prefix to Ctrl-a and hides the inner tmux status bar', () => {
    const args = buildClaudeStatusBarArgs(DEFAULT_CLAUDE_SESSION);

    // primary prefix Ctrl+a (dashboard parity); tmux's default Ctrl+b kept
    // as a secondary prefix so existing muscle memory / integrations keep
    // working.
    expect(args).toContain('prefix');
    expect(args[args.indexOf('prefix') + 1]).toBe('C-a');
    expect(args).toContain('prefix2');
    expect(args[args.indexOf('prefix2') + 1]).toBe('C-b');
    // never explicitly unbinds C-b — the secondary prefix needs it live
    expect(args).not.toContain('unbind-key');

    const bindIdxs = args.flatMap((a, i) => (a === 'bind-key' ? [i] : []));
    // q -> detach-client under either prefix.
    expect(bindIdxs.some((i) => args[i + 1] === 'q' && args[i + 2] === 'detach-client')).toBe(true);
    // C-a C-a -> literal Ctrl+a; C-b C-b -> literal Ctrl+b (send-prefix -2)
    expect(bindIdxs.some((i) => args[i + 1] === 'C-a' && args[i + 2] === 'send-prefix')).toBe(true);
    expect(
      bindIdxs.some(
        (i) => args[i + 1] === 'C-b' && args[i + 2] === 'send-prefix' && args[i + 3] === '-2',
      ),
    ).toBe(true);

    // The inner tmux status bar is OFF — the wrapped-pty footer and the
    // dashboard's own status row already show the box name + detach hint.
    const statusIdx = args.indexOf('status');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(args[statusIdx + 1]).toBe('off');
    // scoped to the named session (-t), not the server-global default,
    // because the dashboard's grouped sibling session has its own opt scope.
    expect(args[statusIdx - 1]).toBe(DEFAULT_CLAUDE_SESSION);
    expect(args[statusIdx - 2]).toBe('-t');

    // None of the old custom-styling options remain — that's the regression
    // this test guards against (those plus the inner status bar were the
    // double-footer source).
    expect(args).not.toContain('status-left');
    expect(args).not.toContain('status-right');
    expect(args).not.toContain('status-style');
    expect(args).not.toContain('window-status-format');

    // every server-global `set` is `-g`; every session-scoped one is `-t <s>`.
    const setIdxs = args.flatMap((a, i) => (a === 'set' ? [i] : []));
    for (const i of setIdxs) {
      const flag = args[i + 1];
      if (flag === '-t') expect(args[i + 2]).toBe(DEFAULT_CLAUDE_SESSION);
      else expect(flag).toBe('-g');
    }
  });

  it('scopes the status-off option to a custom session name', () => {
    const args = buildClaudeStatusBarArgs('codex');
    const sessionSetIdxs = args.flatMap((a, idx) =>
      a === 'set' && args[idx + 1] === '-t' ? [idx] : [],
    );
    expect(sessionSetIdxs.length).toBeGreaterThan(0);
    for (const i of sessionSetIdxs) {
      expect(args[i + 2]).toBe('codex');
    }
  });
});

describe('buildClaudeMounts', () => {
  it('mounts the resolved volume at /home/vscode/.claude', () => {
    const result = buildClaudeMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.claude']);
    expect(result.volumeName).toBe('my-vol');
  });

  it('forwards ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
    );
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
    });
  });

  it('forwards CLAUDE_EFFORT and ANTHROPIC_MODEL when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { CLAUDE_EFFORT: 'xhigh', ANTHROPIC_MODEL: 'claude-opus-4-7' },
    );
    expect(result.env).toEqual({
      CLAUDE_EFFORT: 'xhigh',
      ANTHROPIC_MODEL: 'claude-opus-4-7',
    });
  });

  it('skips empty/missing env values rather than injecting blanks', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      {
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_EFFORT: '',
        ANTHROPIC_MODEL: undefined,
        OTHER_KEY: 'x',
      },
    );
    expect(result.env).toEqual({});
  });
});

describe('scanPluginCacheForRebuild', () => {
  let root: string;
  const versionDir = (m: string, p: string, v: string) =>
    join(root, m, p, v);
  const seed = async (m: string, p: string, v: string, files: string[]) => {
    const d = versionDir(m, p, v);
    await mkdir(d, { recursive: true });
    for (const f of files) await writeFile(join(d, f), '{}');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when the cache root does not exist', async () => {
    expect(await scanPluginCacheForRebuild(join(root, 'nope'))).toBe(false);
  });

  it('returns false when every package.json plugin has the install marker', async () => {
    await seed('mkt', 'plug', '1.0.0', ['package.json', '.agentbox-installed']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('returns true when a package.json plugin is missing the marker', async () => {
    await seed('mkt', 'a', '1.0.0', ['package.json', '.agentbox-installed']);
    await seed('mkt', 'b', '2.1.0', ['package.json']);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });

  it('ignores skill-only plugins that ship no package.json', async () => {
    await seed('mkt', 'skill-only', 'unknown', ['SKILL.md']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('skips a plugin with a recent install-failure marker (backoff)', async () => {
    await seed('mkt', 'flaky', '1.0.0', ['package.json', '.agentbox-install-failed']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('retries a plugin whose failure marker has aged past the backoff window', async () => {
    await seed('mkt', 'flaky', '1.0.0', ['package.json', '.agentbox-install-failed']);
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000); // > 6h backoff
    await utimes(versionDir('mkt', 'flaky', '1.0.0') + '/.agentbox-install-failed', stale, stale);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });
});
