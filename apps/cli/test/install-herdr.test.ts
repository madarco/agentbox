import { describe, expect, it } from 'vitest';
import { buildHerdrManifest, herdrBinary, herdrPluginDir } from '../src/commands/install-herdr.js';

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

  it('binds the two keyboard shortcuts to plugin actions', () => {
    expect(toml).toContain('key = "prefix+a"');
    expect(toml).toContain('command = "agentbox.boxes"');
    expect(toml).toContain('key = "prefix+shift+a"');
    expect(toml).toContain('command = "agentbox.new"');
  });

  it('registers the agentbox:// link handler routed to the link action', () => {
    expect(toml).toContain('pattern = "^agentbox://"');
    expect(toml).toContain('action = "link"');
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
