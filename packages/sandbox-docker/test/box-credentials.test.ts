import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// BOXES_ROOT is resolved from $HOME at import, so HOME is redirected first and
// the module is imported after: these tests must never touch the real ~/.agentbox.
let home: string;
let mod: typeof import('../src/box-credentials.js');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentbox-box-creds-'));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  mod = await import('../src/box-credentials.js');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const box = { id: 'b1', name: 'web', projectIndex: 2 };

describe('per-box credential file', () => {
  it('mounts the box`s own file over the agent`s in-box path', () => {
    expect(mod.boxCredentialMount(box, 'claude')).toBe(
      `${join(home, '.agentbox', 'boxes', 'b1-2-web', 'credentials', 'claude', '.credentials.json')}:/home/vscode/.claude/.credentials.json`,
    );
  });

  it('rewrites the same inode, so a running container sees the new login', async () => {
    const file = await mod.writeBoxCredentialFile(box, 'claude', '{"a":1}');
    const before = (await stat(file)).ino;
    await mod.writeBoxCredentialFile(box, 'claude', '{"b":2}');
    expect((await stat(file)).ino).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('{"b":2}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('gives claude a logged-out placeholder, and no file to an agent without a safe empty value', () => {
    expect(mod.emptyCredentialPlaceholder('claude')).toBe('{}\n');
    expect(mod.emptyCredentialPlaceholder('codex')).toBeNull();
  });
});
