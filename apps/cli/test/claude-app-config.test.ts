import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSettingsPath,
  claudeSshEntryFor,
  removeClaudeSshConfigs,
  upsertClaudeSshConfig,
} from '../src/lib/claude-app-config.js';

// apps/cli tests have no global $HOME isolation — point HOME at a scratch dir
// for this file so we never touch the user's REAL ~/.claude/settings.json.
let home: string;
const realHome = process.env.HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentbox-claude-cfg-'));
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(home, '.claude'), { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsPath(), 'utf8')) as Record<string, unknown>;
}

describe('claudeSshEntryFor', () => {
  it('builds the app-schema entry from the box ssh alias', () => {
    expect(claudeSshEntryFor('mybox', 'mybox')).toEqual({
      id: 'agentbox-mybox',
      name: 'AgentBox: mybox',
      sshHost: 'mybox',
      startDirectory: '/workspace',
    });
  });
});

describe('upsertClaudeSshConfig', () => {
  it('creates settings.json when missing', () => {
    upsertClaudeSshConfig(claudeSshEntryFor('a', 'a'));
    expect(readSettings()).toEqual({
      sshConfigs: [claudeSshEntryFor('a', 'a')],
    });
  });

  it('preserves unknown settings keys and foreign sshConfigs entries', () => {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'] },
        sshConfigs: [{ id: 'user-vps', name: 'My VPS', sshHost: 'me@vps.example' }],
      }),
    );
    upsertClaudeSshConfig(claudeSshEntryFor('boxy', 'boxy'));
    const s = readSettings();
    expect(s['model']).toBe('opus');
    expect(s['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    expect(s['sshConfigs']).toEqual([
      { id: 'user-vps', name: 'My VPS', sshHost: 'me@vps.example' },
      claudeSshEntryFor('boxy', 'boxy'),
    ]);
  });

  it('replaces by id instead of duplicating', () => {
    upsertClaudeSshConfig(claudeSshEntryFor('a', 'a'));
    upsertClaudeSshConfig({ ...claudeSshEntryFor('a', 'a'), name: 'AgentBox: renamed' });
    const s = readSettings();
    expect(s['sshConfigs']).toHaveLength(1);
    expect((s['sshConfigs'] as { name: string }[])[0]?.name).toBe('AgentBox: renamed');
  });

  it('refuses to touch a corrupt settings.json', () => {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    expect(() => upsertClaudeSshConfig(claudeSshEntryFor('a', 'a'))).toThrow(/not valid JSON/);
    // The corrupt file must be left exactly as it was.
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });

  it('refuses a settings file that is not a JSON object', () => {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[1,2]');
    expect(() => upsertClaudeSshConfig(claudeSshEntryFor('a', 'a'))).toThrow(/not a JSON object/);
  });
});

describe('removeClaudeSshConfigs', () => {
  it('removes matching entries and keeps the rest', () => {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: 'opus',
        sshConfigs: [
          { id: 'user-vps', name: 'My VPS', sshHost: 'me@vps.example' },
          claudeSshEntryFor('gone', 'gone'),
        ],
      }),
    );
    expect(removeClaudeSshConfigs((id) => id === 'agentbox-gone')).toBe(1);
    const s = readSettings();
    expect(s['sshConfigs']).toEqual([{ id: 'user-vps', name: 'My VPS', sshHost: 'me@vps.example' }]);
    expect(s['model']).toBe('opus');
  });

  it('is a no-op (no rewrite) when nothing matches or the file is missing', () => {
    expect(removeClaudeSshConfigs(() => true)).toBe(0);
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify({ sshConfigs: [{ id: 'user-vps', sshHost: 'x' }] });
    writeFileSync(path, body);
    expect(removeClaudeSshConfigs((id) => id.startsWith('agentbox-'))).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  it('ignores entries with no id', () => {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sshConfigs: [{ sshHost: 'x' }] }));
    expect(removeClaudeSshConfigs(() => true)).toBe(0);
  });
});
