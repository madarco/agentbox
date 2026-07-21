import { describe, expect, it } from 'vitest';
import {
  buildOpencodeAttachArgv,
  buildOpencodeLoginRunArgv,
  buildOpencodeMounts,
  DEFAULT_OPENCODE_SESSION,
  resolveOpencodeVolume,
  SHARED_OPENCODE_VOLUME,
} from '../src/sync/agents/opencode.js';

describe('resolveOpencodeVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolveOpencodeVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_OPENCODE_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolveOpencodeVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_OPENCODE_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildOpencodeMounts', () => {
  it('mounts the volume at the OpenCode data dir and sets OPENCODE_CONFIG_DIR', () => {
    const result = buildOpencodeMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.local/share/opencode']);
    expect(result.volumeName).toBe('my-vol');
    // Config dir is relocated into a subdir of the same volume.
    expect(result.env['OPENCODE_CONFIG_DIR']).toBe('/home/vscode/.local/share/opencode/config');
  });

  it('forwards provider API keys when set on the host', () => {
    const result = buildOpencodeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' },
    );
    expect(result.env['ANTHROPIC_API_KEY']).toBe('sk-ant');
    expect(result.env['OPENAI_API_KEY']).toBe('sk-oai');
  });

  it('skips empty/missing provider keys but always sets the relocated dir env', () => {
    const result = buildOpencodeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: undefined, OTHER_KEY: 'x' },
    );
    expect(result.env).toEqual({
      OPENCODE_CONFIG_DIR: '/home/vscode/.local/share/opencode/config',
      XDG_STATE_HOME: '/home/vscode/.local/share/opencode/.state',
    });
  });
});

describe('buildOpencodeLoginRunArgv', () => {
  it('runs `opencode auth login` with the volume mounted and OPENCODE_CONFIG_DIR set', () => {
    const argv = buildOpencodeLoginRunArgv({
      volume: SHARED_OPENCODE_VOLUME,
      image: 'agentbox/box:dev',
      extraArgs: [],
    });
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-it');
    expect(argv).toContain(`${SHARED_OPENCODE_VOLUME}:/home/vscode/.local/share/opencode`);
    expect(argv).toContain('agentbox/box:dev');
    expect(argv).toContain('OPENCODE_CONFIG_DIR=/home/vscode/.local/share/opencode/config');
    expect(argv).toContain('XDG_STATE_HOME=/home/vscode/.local/share/opencode/.state');
    expect(argv.slice(-3)).toEqual(['opencode', 'auth', 'login']);
  });

  it('blanks DISPLAY and appends extra args verbatim', () => {
    const argv = buildOpencodeLoginRunArgv({
      volume: 'v',
      image: 'img',
      extraArgs: ['--provider', 'anthropic'],
    });
    const i = argv.indexOf('DISPLAY=');
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe('-e');
    expect(argv.slice(-5)).toEqual(['opencode', 'auth', 'login', '--provider', 'anthropic']);
  });
});

describe('buildOpencodeAttachArgv', () => {
  it('attaches to the default opencode tmux session', () => {
    const argv = buildOpencodeAttachArgv('agentbox-box1');
    expect(argv.slice(0, 2)).toEqual(['exec', '-it']);
    expect(argv).toContain('agentbox-box1');
    // tmux runs under `sh -c` with the TERM guard; the session name is the
    // final positional bound to "$1" in the script.
    const script = argv[argv.indexOf('-c') + 1]!;
    expect(script).toContain('infocmp "$TERM"');
    expect(script).toContain('exec tmux attach -t "$1"');
    expect(argv[argv.length - 1]).toBe(DEFAULT_OPENCODE_SESSION);
  });

  it('attaches to a custom session name', () => {
    const argv = buildOpencodeAttachArgv('agentbox-box1', 'my-oc');
    expect(argv[argv.length - 1]).toBe('my-oc');
  });
});
