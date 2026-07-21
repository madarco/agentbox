import { describe, expect, it } from 'vitest';
import {
  buildCodexAttachArgv,
  buildCodexLoginRunArgv,
  buildCodexMounts,
  buildCodexOrphanPurgeScript,
  DEFAULT_CODEX_SESSION,
  resolveCodexVolume,
  SHARED_CODEX_VOLUME,
} from '../src/sync/agents/codex.js';

describe('resolveCodexVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolveCodexVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_CODEX_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolveCodexVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_CODEX_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildCodexMounts', () => {
  it('mounts the resolved volume at /home/vscode/.codex', () => {
    const result = buildCodexMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.codex']);
    expect(result.volumeName).toBe('my-vol');
  });

  it('forwards OPENAI_API_KEY when set', () => {
    const result = buildCodexMounts({ volume: 'v' }, { OPENAI_API_KEY: 'sk-test' });
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
  });

  it('skips empty/missing env values rather than injecting blanks', () => {
    const result = buildCodexMounts(
      { volume: 'v' },
      { OPENAI_API_KEY: '', OTHER_KEY: 'x' },
    );
    expect(result.env).toEqual({});
  });
});

describe('buildCodexLoginRunArgv', () => {
  it('defaults to the headless --device-auth flow', () => {
    const argv = buildCodexLoginRunArgv({
      volume: SHARED_CODEX_VOLUME,
      image: 'agentbox/box:dev',
      extraArgs: [],
    });
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-it');
    expect(argv).toContain(`${SHARED_CODEX_VOLUME}:/home/vscode/.codex`);
    expect(argv).toContain('agentbox/box:dev');
    expect(argv.slice(-3)).toEqual(['codex', 'login', '--device-auth']);
  });

  it('passes explicit extra args verbatim instead of --device-auth', () => {
    const argv = buildCodexLoginRunArgv({
      volume: 'v',
      image: 'img',
      extraArgs: ['--api-key'],
    });
    expect(argv.slice(-3)).toEqual(['codex', 'login', '--api-key']);
    expect(argv).not.toContain('--device-auth');
  });

  it('blanks DISPLAY and runs as vscode', () => {
    const argv = buildCodexLoginRunArgv({ volume: 'v', image: 'img', extraArgs: [] });
    const i = argv.indexOf('DISPLAY=');
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe('-e');
    expect(argv).toContain('--user');
    expect(argv).toContain('vscode');
  });
});

describe('buildCodexAttachArgv', () => {
  it('attaches to the default codex tmux session', () => {
    const argv = buildCodexAttachArgv('agentbox-box1');
    expect(argv.slice(0, 2)).toEqual(['exec', '-it']);
    expect(argv).toContain('agentbox-box1');
    // tmux runs under `sh -c` with the TERM guard; the session name is the
    // final positional bound to "$1" in the script.
    const script = argv[argv.indexOf('-c') + 1]!;
    expect(script).toContain('infocmp "$TERM"');
    expect(script).toContain('exec tmux attach -t "$1"');
    expect(argv[argv.length - 1]).toBe(DEFAULT_CODEX_SESSION);
  });

  it('attaches to a custom session name', () => {
    const argv = buildCodexAttachArgv('agentbox-box1', 'my-codex');
    expect(argv[argv.length - 1]).toBe('my-codex');
  });
});

describe('buildCodexOrphanPurgeScript', () => {
  it('keeps every named marketplace in both dirs', () => {
    const script = buildCodexOrphanPurgeScript(['claude-plugins-official', 'my-market']);
    expect(script).toContain('/dst/plugins/cache');
    expect(script).toContain('/dst/.tmp/marketplaces');
    expect(script).toContain('! -name claude-plugins-official');
    expect(script).toContain('! -name my-market');
    // only direct children, never recursive matching inside a kept marketplace
    expect(script).toContain('-mindepth 1 -maxdepth 1');
    // missing dirs must not fail the sync shell (`&&` chain)
    expect(script).toContain('|| true');
  });

  it('purges everything on an empty keep-set', () => {
    const script = buildCodexOrphanPurgeScript([]);
    expect(script).not.toContain('! -name');
    expect(script).toContain('-exec rm -rf {} +');
  });

  it('shell-quotes hostile marketplace names', () => {
    const script = buildCodexOrphanPurgeScript(["evil'; rm -rf /; '", 'has space']);
    expect(script).toContain(`! -name 'evil'\\''; rm -rf /; '\\'''`);
    expect(script).toContain(`! -name 'has space'`);
  });
});
