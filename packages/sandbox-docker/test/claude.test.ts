import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDashboardAttachArgv,
  buildClaudeLoginRunArgv,
  buildClaudeMounts,
  buildTmuxSessionArgs,
  buildTmuxConfigShellSnippet,
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

describe('buildDashboardAttachArgv', () => {
  it('attaches via a grouped sibling session with the inner status bar off', () => {
    const argv = buildDashboardAttachArgv('agentbox-box1');
    // docker exec head, then the tmux command runs under `sh -c` with the TERM guard.
    expect(argv.slice(0, 7)).toEqual([
      'exec',
      '-it',
      '-e',
      `TERM=${process.env['TERM'] ?? 'xterm-256color'}`,
      '--user',
      'vscode',
      'agentbox-box1',
    ]);
    const script = argv[argv.indexOf('-c') + 1]!;
    expect(script).toContain('infocmp "$TERM"');
    // grouped session name derived in-shell, created (or no-op) and status off
    // before attach, attach last.
    expect(script).toContain('dash="$1-dash"');
    expect(script).toContain('new-session -A -d -s "$dash" -t "$1"');
    expect(script).toContain('set -t "$dash" status off');
    expect(script).toMatch(/attach -t "\$dash"\s*$/);
    // the base session name is the single positional bound to "$1".
    expect(argv[argv.length - 1]).toBe(DEFAULT_CLAUDE_SESSION);
  });

  it('derives the grouped session from a custom session name', () => {
    const argv = buildDashboardAttachArgv('agentbox-box1', 'codex');
    // the base session name is the single positional; the grouped "-dash" name
    // is derived from it in-shell.
    expect(argv[argv.length - 1]).toBe('codex');
    const script = argv[argv.indexOf('-c') + 1]!;
    expect(script).toContain('dash="$1-dash"');
    // never attaches directly to the original session (would show its footer).
    expect(script).toContain('attach -t "$dash"');
    expect(script).not.toContain('attach -t "$1"');
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
  it('points at `shell attach` for the shell command', () => {
    expect(formatDetachNotice('2', 'shell')).toBe(
      'Session detached. Reattach with: agentbox shell attach 2',
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

describe('buildTmuxSessionArgs', () => {
  it('remaps the prefix to Ctrl-a and hides the inner tmux status bar', () => {
    const args = buildTmuxSessionArgs(DEFAULT_CLAUDE_SESSION);

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
    // d -> detach-client under either prefix.
    expect(bindIdxs.some((i) => args[i + 1] === 'd' && args[i + 2] === 'detach-client')).toBe(true);
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

    // every server-global `set` is `-g`/`-as` (append to a list-typed global,
    // e.g. terminal-features); every session-scoped one is `-t <s>`.
    const setIdxs = args.flatMap((a, i) => (a === 'set' ? [i] : []));
    for (const i of setIdxs) {
      const flag = args[i + 1];
      if (flag === '-t') expect(args[i + 2]).toBe(DEFAULT_CLAUDE_SESSION);
      else expect(['-g', '-as']).toContain(flag);
    }
  });

  it('scopes the status-off option to a custom session name', () => {
    const args = buildTmuxSessionArgs('codex');
    const sessionSetIdxs = args.flatMap((a, idx) =>
      a === 'set' && args[idx + 1] === '-t' ? [idx] : [],
    );
    expect(sessionSetIdxs.length).toBeGreaterThan(0);
    for (const i of sessionSetIdxs) {
      expect(args[i + 2]).toBe('codex');
    }
  });
});

describe('buildTmuxConfigShellSnippet', () => {
  it('formats the same config as a sequence of tmux shell statements', () => {
    const snippet = buildTmuxConfigShellSnippet('claude');
    // Every subcommand is its own `tmux …` invocation joined with `; ` so
    // it can ride through `ssh -t '...'` without `;` collisions inside
    // tmux's own command parser.
    const parts = snippet.split('; ');
    for (const p of parts) expect(p).toMatch(/^tmux /);
    // The user-visible regression target: the inner status bar is OFF and
    // scoped to the named session.
    expect(snippet).toContain('tmux set -t claude status off');
    // Prefix remap survives the format change.
    expect(snippet).toContain('tmux set -g prefix C-a');
    expect(snippet).toContain('tmux set -g prefix2 C-b');
    // The `,*:extkeys` value MUST be shell-quoted — the `*` would otherwise
    // glob against the cwd and break the tmux call.
    expect(snippet).toContain("tmux set -as terminal-features ',*:extkeys'");
  });

  it('threads a custom session name into the session-scoped option', () => {
    const snippet = buildTmuxConfigShellSnippet('codex');
    expect(snippet).toContain('tmux set -t codex status off');
    expect(snippet).not.toContain('tmux set -t claude status off');
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
  // Real layout: <pluginsDir>/cache/<m>/<p>/<v> + <pluginsDir>/installed_plugins.json.
  let pluginsDir: string;
  let root: string; // the cache dir passed to scanPluginCacheForRebuild
  const versionDir = (m: string, p: string, v: string) => join(root, m, p, v);
  const seed = async (m: string, p: string, v: string, files: string[]) => {
    const d = versionDir(m, p, v);
    await mkdir(d, { recursive: true });
    for (const f of files) await writeFile(join(d, f), '{}');
  };
  /** Write installed_plugins.json referencing the given `<m>/<p>/<v>` keys. */
  const writeInstalledPlugins = async (keys: string[]) => {
    const plugins: Record<string, Array<{ installPath: string }>> = {};
    keys.forEach((key, i) => {
      plugins[`p${String(i)}@mkt`] = [
        { installPath: `/home/vscode/.claude/plugins/cache/${key}` },
      ];
    });
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins }),
    );
  };

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'agentbox-plugins-'));
    root = join(pluginsDir, 'cache');
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
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

  it('does not count an unreferenced un-marked plugin version as rebuild work', async () => {
    await seed('mkt', 'a', '2.0.0', ['package.json', '.agentbox-installed']); // current
    await seed('mkt', 'a', '1.0.0', ['package.json']); // stale leftover, un-marked
    await writeInstalledPlugins(['mkt/a/2.0.0']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('still counts a referenced un-marked plugin version as rebuild work', async () => {
    await seed('mkt', 'a', '2.0.0', ['package.json']); // referenced, un-marked
    await seed('mkt', 'a', '1.0.0', ['package.json']); // stale leftover
    await writeInstalledPlugins(['mkt/a/2.0.0']);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });

  it('falls back to counting all un-marked plugins when installed_plugins.json is absent', async () => {
    await seed('mkt', 'a', '1.0.0', ['package.json']);
    await seed('mkt', 'a', '2.0.0', ['package.json']);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });
});
