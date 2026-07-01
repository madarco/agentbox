import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHerdrManifest,
  herdrBinary,
  herdrBuildScript,
  herdrConfigPath,
  herdrKeybindingsBlock,
  herdrPluginDir,
  herdrShimContent,
  upsertHerdrKeybindings,
} from '../src/commands/install-herdr.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('buildHerdrManifest', () => {
  const toml = buildHerdrManifest();

  it('declares the plugin id, a stable own version, and platforms', () => {
    expect(toml).toContain('id = "agentbox"');
    expect(toml).toContain('version = "0.2.0"'); // plugin version, not the CLI version
    expect(toml).toContain('min_herdr_version = "0.7.0"');
    expect(toml).toContain('platforms = ["linux", "macos", "windows"]');
  });

  it('routes agentbox commands through the shim and runs the build step', () => {
    expect(toml).toContain('command = ["sh", "build.sh"]');
    expect(toml).toContain('command = ["sh", "agentbox-shim.sh", "list", "--herdr", "--watch"]');
    expect(toml).toContain('command = ["sh", "agentbox-shim.sh", "herdr", "new"]');
    expect(toml).toContain('command = ["sh", "agentbox-shim.sh", "herdr", "link"]');
    // pane-open uses bare `herdr` (reliably on PATH inside a Herdr pane)
    expect(toml).toContain('"herdr", "plugin", "pane", "open"');
  });

  it('does NOT declare keybindings (Herdr ignores manifest keys)', () => {
    expect(toml).not.toContain('[[keys.command]]');
    expect(toml).not.toContain('plugin_action');
  });

  it('registers the agentbox:// link handler routed to the link action', () => {
    expect(toml).toContain('pattern = "^agentbox://"');
    expect(toml).toContain('action = "link"');
  });
});

describe('committed plugin stays in sync with the builders', () => {
  // Files live at the repo root (not a subdir) so the Herdr marketplace, which
  // indexes herdr-plugin.toml from each tagged repo's root, can discover them.
  it('herdr-plugin.toml (repo root) matches buildHerdrManifest()', () => {
    const committed = readFileSync(join(REPO_ROOT, 'herdr-plugin.toml'), 'utf8');
    expect(committed).toBe(buildHerdrManifest());
  });

  it('build.sh (repo root) matches herdrBuildScript()', () => {
    const committed = readFileSync(join(REPO_ROOT, 'build.sh'), 'utf8');
    expect(committed).toBe(herdrBuildScript());
  });
});

describe('herdrShimContent', () => {
  it('exec-launches the CLI by absolute node + entry, shell-quoted', () => {
    const shim = herdrShimContent('/usr/local/bin/node', '/opt/agentbox/dist/index.js');
    expect(shim).toContain("exec '/usr/local/bin/node' '/opt/agentbox/dist/index.js' \"$@\"");
    expect(shim.startsWith('#!/bin/sh')).toBe(true);
  });
});

describe('herdrBuildScript', () => {
  const sh = herdrBuildScript();
  it('installs setup when the CLI is present, instructs (exit 0) when not', () => {
    expect(sh).toContain('command -v agentbox');
    expect(sh).toContain('install herdr --plugin-keys');
    expect(sh).toContain('npm i -g @madarco/agentbox');
    expect(sh).toContain('exit 0'); // never aborts the plugin install
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

describe('herdrPluginDir / herdrConfigPath / herdrBinary', () => {
  it('plugin dir lives under AGENTBOX_HOME, else ~/.agentbox', () => {
    expect(herdrPluginDir({ AGENTBOX_HOME: '/tmp/ab' })).toBe('/tmp/ab/herdr/plugin');
    expect(herdrPluginDir({})).toMatch(/\.agentbox\/herdr\/plugin$/);
  });
  it('config path honors HERDR_CONFIG_PATH / XDG_CONFIG_HOME', () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: '/x/herdr.toml' })).toBe('/x/herdr.toml');
    expect(herdrConfigPath({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/herdr/config.toml');
    expect(herdrConfigPath({})).toMatch(/\.config\/herdr\/config\.toml$/);
  });
  it('herdr binary prefers HERDR_BIN_PATH, else bare herdr', () => {
    expect(herdrBinary({ HERDR_BIN_PATH: '/x/herdr' })).toBe('/x/herdr');
    expect(herdrBinary({})).toBe('herdr');
  });
});
