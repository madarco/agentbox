import { describe, expect, it } from 'vitest';
import {
  buildHerdrManifest,
  herdrBinary,
  herdrConfigPath,
  herdrKeybindingsBlock,
  herdrPluginDir,
  upsertHerdrKeybindings,
} from '../src/commands/install-herdr.js';

const PATHS = {
  version: '9.9.9',
  node: '/usr/local/bin/node',
  cliEntry: '/opt/agentbox/dist/index.js',
  herdrBin: '/Applications/Herdr.app/Contents/MacOS/herdr',
};

describe('buildHerdrManifest', () => {
  const toml = buildHerdrManifest(PATHS);

  it('declares the plugin id and version', () => {
    expect(toml).toContain('id = "agentbox"');
    expect(toml).toContain('version = "9.9.9"');
    expect(toml).toContain('min_herdr_version = "0.7.0"');
    expect(toml).toContain('platforms = ["linux", "macos", "windows"]');
  });

  it('declares the boxes overlay pane running `list --herdr --watch` with absolute paths', () => {
    expect(toml).toContain('placement = "overlay"');
    expect(toml).toContain(
      'command = ["/usr/local/bin/node", "/opt/agentbox/dist/index.js", "list", "--herdr", "--watch"]',
    );
  });

  it('wires the three actions with resolved commands', () => {
    // boxes overlay opens via the herdr binary
    expect(toml).toContain(
      'command = ["/Applications/Herdr.app/Contents/MacOS/herdr", "plugin", "pane", "open", "--plugin", "agentbox", "--entrypoint", "boxes", "--placement", "overlay"]',
    );
    // new + link route back into the agentbox CLI
    expect(toml).toContain('command = ["/usr/local/bin/node", "/opt/agentbox/dist/index.js", "herdr", "new"]');
    expect(toml).toContain('command = ["/usr/local/bin/node", "/opt/agentbox/dist/index.js", "herdr", "link"]');
  });

  it('does NOT declare keybindings in the manifest (Herdr ignores manifest keys)', () => {
    expect(toml).not.toContain('[[keys.command]]');
    expect(toml).not.toContain('plugin_action');
  });

  it('registers the agentbox:// link handler routed to the link action', () => {
    expect(toml).toContain('pattern = "^agentbox://"');
    expect(toml).toContain('action = "link"');
  });
});

describe('herdr keybindings (config.toml)', () => {
  const block = herdrKeybindingsBlock();

  it('binds prefix+a / prefix+shift+a to the plugin actions', () => {
    expect(block).toContain('[[keys.command]]');
    expect(block).toContain('key = "prefix+a"');
    expect(block).toContain('command = "agentbox.boxes"');
    expect(block).toContain('key = "prefix+shift+a"');
    expect(block).toContain('command = "agentbox.new"');
    expect(block).toContain('type = "plugin_action"');
  });

  it('appends the block to an existing config, preserving prior content', () => {
    const out = upsertHerdrKeybindings('[ui]\nmouse_capture = true\n', block);
    expect(out).toContain('[ui]');
    expect(out).toContain('mouse_capture = true');
    expect(out.endsWith(block + '\n')).toBe(true);
  });

  it('is idempotent — re-running replaces the managed block, not duplicates it', () => {
    const once = upsertHerdrKeybindings('[ui]\n', block);
    const twice = upsertHerdrKeybindings(once, block);
    expect(twice).toBe(once);
    expect(twice.match(/key = "prefix\+a"/g)?.length).toBe(1);
  });

  it('creates a clean file from empty input', () => {
    expect(upsertHerdrKeybindings('', block)).toBe(block + '\n');
  });
});

describe('herdrConfigPath', () => {
  it('honors HERDR_CONFIG_PATH', () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: '/x/herdr.toml' })).toBe('/x/herdr.toml');
  });
  it('honors XDG_CONFIG_HOME, else ~/.config', () => {
    expect(herdrConfigPath({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/herdr/config.toml');
    expect(herdrConfigPath({})).toMatch(/\.config\/herdr\/config\.toml$/);
  });
});

describe('herdrPluginDir', () => {
  it('lives under AGENTBOX_HOME when set', () => {
    expect(herdrPluginDir({ AGENTBOX_HOME: '/tmp/ab' })).toBe('/tmp/ab/herdr/plugin');
  });
  it('falls back to ~/.agentbox', () => {
    expect(herdrPluginDir({})).toMatch(/\.agentbox\/herdr\/plugin$/);
  });
});

describe('herdrBinary', () => {
  it('prefers the in-session HERDR_BIN_PATH', () => {
    expect(herdrBinary({ HERDR_BIN_PATH: '/x/herdr' })).toBe('/x/herdr');
  });
  it('falls back to bare `herdr` on PATH', () => {
    expect(herdrBinary({})).toBe('herdr');
  });
});
