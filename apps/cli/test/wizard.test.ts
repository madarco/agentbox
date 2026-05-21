import { describe, expect, it } from 'vitest';
import {
  buildSetupInitialPrompt,
  IN_BOX_SETUP_GUIDE_PATH,
  parseEnvFilesFromEnv,
  passthroughFlags,
  serializeEnvFilesForEnv,
} from '../src/wizard.js';

const NUL = String.fromCharCode(0);

describe('passthroughFlags', () => {
  it('returns empty for an empty options object', () => {
    expect(passthroughFlags({})).toEqual([]);
  });

  it('emits --host-snapshot / --no-host-snapshot based on the tri-state', () => {
    expect(passthroughFlags({ hostSnapshot: true })).toEqual(['--host-snapshot']);
    expect(passthroughFlags({ hostSnapshot: false })).toEqual(['--no-host-snapshot']);
    expect(passthroughFlags({ hostSnapshot: undefined })).toEqual([]);
  });

  it('forwards --snapshot <ref> (checkpoint) as a value flag', () => {
    expect(passthroughFlags({ snapshot: 'warm-1' })).toEqual(['--snapshot', 'warm-1']);
    expect(passthroughFlags({ snapshot: undefined })).toEqual([]);
  });

  it('emits --no-vnc only when vnc is explicitly false', () => {
    expect(passthroughFlags({ vnc: true })).toEqual([]);
    expect(passthroughFlags({ vnc: false })).toEqual(['--no-vnc']);
  });

  it('forwards workspace / name / image as value flags', () => {
    expect(
      passthroughFlags({ workspace: '/tmp/x', name: 'foo', image: 'agentbox/box:dev' }),
    ).toEqual(['--workspace', '/tmp/x', '--name', 'foo', '--image', 'agentbox/box:dev']);
  });

  it('forwards boolean flags only when true', () => {
    expect(passthroughFlags({ withPlaywright: true, sharedDockerCache: true })).toEqual([
      '--with-playwright',
      '--shared-docker-cache',
    ]);
    expect(passthroughFlags({ withPlaywright: false, sharedDockerCache: false })).toEqual([]);
  });

  it('does NOT forward --yes (would suppress the first-run auth guidance)', () => {
    const out = passthroughFlags({ workspace: '/tmp/x' } as never);
    expect(out).not.toContain('--yes');
  });
});

describe('buildSetupInitialPrompt', () => {
  it('includes the workspace basename and the in-box guide path', () => {
    const prompt = buildSetupInitialPrompt('/Users/me/repos/cool-project');
    expect(prompt).toContain('cool-project');
    expect(prompt).toContain(IN_BOX_SETUP_GUIDE_PATH);
    expect(prompt).toMatch(/\/workspace\/agentbox\.yaml/);
  });

  it('references the /agentbox-setup skill so claude invokes it', () => {
    const prompt = buildSetupInitialPrompt('/x/y');
    expect(prompt).toContain('/agentbox-setup');
  });

  it('instructs claude to reload the supervisor so tasks run immediately', () => {
    const prompt = buildSetupInitialPrompt('/x/y');
    expect(prompt).toContain('agentbox-ctl reload');
  });
});

describe('serializeEnvFilesForEnv / parseEnvFilesFromEnv', () => {
  it('round-trips a non-empty list via NUL delimiter', () => {
    const files = ['.env', '.env.local', 'apps/web/.env'];
    const raw = serializeEnvFilesForEnv(files);
    expect(raw).toBe(['.env', '.env.local', 'apps/web/.env'].join(NUL));
    expect(parseEnvFilesFromEnv(raw)).toEqual(files);
  });

  it('returns undefined for empty / nullish input on both sides', () => {
    expect(serializeEnvFilesForEnv(undefined)).toBeUndefined();
    expect(serializeEnvFilesForEnv([])).toBeUndefined();
    expect(parseEnvFilesFromEnv(undefined)).toBeUndefined();
    expect(parseEnvFilesFromEnv('')).toBeUndefined();
  });

  it('survives filenames with newlines (NUL is the only POSIX-illegal byte)', () => {
    const files = ['weird\nname.env', '.env'];
    const raw = serializeEnvFilesForEnv(files);
    expect(parseEnvFilesFromEnv(raw)).toEqual(files);
  });

  it('drops empty fragments on parse (defensive against stray trailing NUL)', () => {
    // Three NUL bytes around two entries — what a malformed env value might look like.
    const raw = ['.env', '', '.env.local', ''].join(NUL);
    expect(parseEnvFilesFromEnv(raw)).toEqual(['.env', '.env.local']);
  });
});
