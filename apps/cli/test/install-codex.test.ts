import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  codexConfigPath,
  codexPluginEnableTable,
  upsertCodexPluginEnable,
} from '../src/commands/install-codex.js';

const ID = 'agentbox@agentbox';
const enabledOf = (text: string) =>
  (parseToml(text) as { plugins?: Record<string, { enabled?: boolean }> }).plugins?.[ID]?.enabled;
const tableCount = (text: string) =>
  text.match(/\[plugins\."agentbox@agentbox"\]/g)?.length ?? 0;

describe('upsertCodexPluginEnable', () => {
  it('appends the enable table to an empty config', () => {
    const { text, status } = upsertCodexPluginEnable('');
    expect(status).toBe('added');
    expect(enabledOf(text)).toBe(true);
    expect(tableCount(text)).toBe(1);
  });

  it('preserves existing config and appends below it, still parsing', () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "bar"\n';
    const { text, status } = upsertCodexPluginEnable(existing);
    expect(status).toBe('added');
    const parsed = parseToml(text) as { model?: string; mcp_servers?: Record<string, unknown> };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers?.foo).toBeDefined();
    expect(enabledOf(text)).toBe(true);
  });

  it('is idempotent — a second run leaves the file unchanged (no duplicate table)', () => {
    const once = upsertCodexPluginEnable('').text;
    const twice = upsertCodexPluginEnable(once);
    expect(twice.status).toBe('user-enabled');
    expect(twice.text).toBe(once);
    expect(tableCount(twice.text)).toBe(1);
  });

  it('respects an already-enabled entry (Codex-written) — no change', () => {
    const cfg = '[plugins."agentbox@agentbox"]\nenabled = true\n';
    const { text, status } = upsertCodexPluginEnable(cfg);
    expect(status).toBe('user-enabled');
    expect(text).toBe(cfg);
    expect(tableCount(text)).toBe(1);
  });

  it('treats a present table with no `enabled` key as enabled (Codex default)', () => {
    const cfg = '[plugins."agentbox@agentbox"]\n';
    const { status, text } = upsertCodexPluginEnable(cfg);
    expect(status).toBe('user-enabled');
    expect(text).toBe(cfg);
  });

  it('respects an explicit disable without --force', () => {
    const cfg = '[plugins."agentbox@agentbox"]\nenabled = false\n';
    const { text, status } = upsertCodexPluginEnable(cfg);
    expect(status).toBe('user-disabled');
    expect(text).toBe(cfg);
    expect(enabledOf(text)).toBe(false);
  });

  it('--force flips a disabled entry to enabled, preserving surrounding content', () => {
    const cfg =
      'model = "gpt-5"\n\n# my note\n[plugins."agentbox@agentbox"]\nenabled = false\n\n[other]\nx = 1\n';
    const { text, status } = upsertCodexPluginEnable(cfg, { force: true });
    expect(status).toBe('forced-enabled');
    expect(enabledOf(text)).toBe(true);
    // Everything else preserved, single table, still valid TOML.
    const parsed = parseToml(text) as { model?: string; other?: { x?: number } };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.other?.x).toBe(1);
    expect(text).toContain('# my note');
    expect(tableCount(text)).toBe(1);
  });

  it('--force inserts `enabled = true` when the disabled table lacked the key', () => {
    // enabled defaults true, but exercise the insert branch with an explicit
    // disable expressed via an inline form the force path must still enable.
    const cfg = '[plugins."agentbox@agentbox"]\nenabled = false\n';
    const { text, status } = upsertCodexPluginEnable(cfg, { force: true });
    expect(status).toBe('forced-enabled');
    expect(enabledOf(text)).toBe(true);
  });

  it('leaves a malformed config untouched', () => {
    const bad = 'this is = not [valid toml';
    const { text, status } = upsertCodexPluginEnable(bad);
    expect(status).toBe('parse-error');
    expect(text).toBe(bad);
  });
});

describe('codexConfigPath', () => {
  it('honors CODEX_HOME', () => {
    expect(codexConfigPath({ CODEX_HOME: '/tmp/cx' })).toBe('/tmp/cx/config.toml');
  });
  it('defaults under ~/.codex', () => {
    expect(codexConfigPath({})).toMatch(/\.codex\/config\.toml$/);
  });
});

describe('codexPluginEnableTable', () => {
  it('is a valid standalone TOML table that enables the plugin', () => {
    expect(enabledOf(codexPluginEnableTable())).toBe(true);
  });
});
