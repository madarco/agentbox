import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuthFile, resolveClaudeAuth } from '../src/auth.js';

describe('readAuthFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-auth-test-'));
    path = join(dir, 'auth.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns {} when the file does not exist', async () => {
    expect(await readAuthFile(path)).toEqual({});
  });

  it('returns the parsed token when present', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 'sk-ant-oat01-abc' }), 'utf8');
    expect(await readAuthFile(path)).toEqual({ claudeCodeOauthToken: 'sk-ant-oat01-abc' });
  });

  it('returns {} when the file is garbage JSON', async () => {
    await writeFile(path, '{not json', 'utf8');
    expect(await readAuthFile(path)).toEqual({});
  });

  it('returns {} when the JSON is shaped wrong', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 42 }), 'utf8');
    expect(await readAuthFile(path)).toEqual({});
  });
});

describe('resolveClaudeAuth precedence', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-auth-test-'));
    path = join(dir, 'auth.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns host-env when ANTHROPIC_API_KEY is set', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 'in-file' }), 'utf8');
    const r = await resolveClaudeAuth({ ANTHROPIC_API_KEY: 'sk-test' }, { authFilePath: path });
    expect(r.source).toBe('host-env');
    expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('returns host-env when CLAUDE_CODE_OAUTH_TOKEN is set (overrides the saved file)', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 'in-file' }), 'utf8');
    const r = await resolveClaudeAuth(
      { CLAUDE_CODE_OAUTH_TOKEN: 'in-env' },
      { authFilePath: path },
    );
    expect(r.source).toBe('host-env');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'in-env' });
  });

  it('falls back to the auth file when env is empty', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 'in-file' }), 'utf8');
    const r = await resolveClaudeAuth({}, { authFilePath: path });
    expect(r.source).toBe('auth-file');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'in-file' });
  });

  it("returns source='none' when nothing is available", async () => {
    const r = await resolveClaudeAuth({}, { authFilePath: path });
    expect(r.source).toBe('none');
    expect(r.env).toEqual({});
  });

  it('ignores empty env values rather than treating them as set', async () => {
    await writeFile(path, JSON.stringify({ claudeCodeOauthToken: 'in-file' }), 'utf8');
    const r = await resolveClaudeAuth(
      { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
      { authFilePath: path },
    );
    expect(r.source).toBe('auth-file');
  });
});
