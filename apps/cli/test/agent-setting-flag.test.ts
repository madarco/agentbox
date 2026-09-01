import { describe, expect, it } from 'vitest';
import { mergeAgentSettings, parseAgentSettingFlags } from '../src/commands/_agent-setting-flag.js';

/**
 * `--agent-setting <agent>.<key>=<value>` is one generic flag because which
 * settings exist is a RUNTIME fact — a commander option per setting could only
 * ever cover the built-ins, never an agent installed from an npm package. The
 * price is that validation has to be written rather than derived from the option
 * table, so it is tested rather than trusted.
 */
describe('parseAgentSettingFlags', () => {
  it('parses and coerces against the declaration', () => {
    expect(parseAgentSettingFlags(['claude.install=npm'])).toEqual({ claude: { install: 'npm' } });
  });

  it('accumulates several settings for one agent', () => {
    expect(parseAgentSettingFlags(['claude.install=npm', 'claude.tui=auto'])).toEqual({
      claude: { install: 'npm', tui: 'auto' },
    });
  });

  it('rejects a value outside a declared enum, naming the choices', () => {
    const err = parseAgentSettingFlags(['claude.install=yarn']);
    expect(err).toBe('--agent-setting claude.install: must be one of: native, npm');
  });

  it('rejects an undeclared key, naming what the agent does declare', () => {
    // The failure this exists to prevent: a typo that silently bakes with the
    // default while the user believes they overrode it.
    expect(parseAgentSettingFlags(['claude.instal=npm'])).toContain('claude.install');
  });

  it('rejects an unknown agent', () => {
    expect(parseAgentSettingFlags(['nope.thing=1'])).toBe('--agent-setting: unknown agent "nope"');
  });

  it('rejects a malformed flag rather than half-parsing it', () => {
    for (const raw of ['claude.install', 'claude=npm', '=npm', '.install=npm', 'claude.=npm']) {
      expect(typeof parseAgentSettingFlags([raw])).toBe('string');
    }
  });

  it('names an agent that declares nothing rather than listing an empty set', () => {
    expect(parseAgentSettingFlags(['opencode.anything=1'])).toBe(
      '--agent-setting: opencode declares no settings',
    );
  });
});

describe('mergeAgentSettings', () => {
  it('layers per SETTING, not per agent block', () => {
    // `--agent-setting claude.install=npm` must not drop the `claude.tui` the
    // project's config set.
    expect(
      mergeAgentSettings(
        { claude: { install: 'native', tui: 'fullscreen' }, codex: { x: 'y' } },
        { claude: { install: 'npm' } },
      ),
    ).toEqual({ claude: { install: 'npm', tui: 'fullscreen' }, codex: { x: 'y' } });
  });

  it('returns the base untouched when there are no overrides', () => {
    const base = { claude: { install: 'npm' } };
    expect(mergeAgentSettings(base, undefined)).toBe(base);
  });
});
