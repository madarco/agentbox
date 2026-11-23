import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @agentbox/config pins its paths to $HOME at import: isolate before importing.
let home: string;
let settings: typeof import('../src/history/host-settings.js');
const realHome = process.env.HOME;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'host-settings-'));
  process.env.HOME = home;
  await mkdir(join(home, '.agentbox'), { recursive: true });
  settings = await import('../src/history/host-settings.js');
});
afterAll(async () => {
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe('hostProjectDecisions', () => {
  it("ignores a checked-in agentbox.yaml default and honours the user's own layers", async () => {
    const repo = join(home, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'agentbox.yaml'), 'defaults:\n  history:\n    hostSessions: true\n');
    let d = await settings.hostProjectDecisions([{ folder: repo }]);
    expect(d.enabled).toBe(false);
    expect(d.projects[0]).toMatchObject({ mode: 'inherit', allowed: false, reason: 'off' });

    await settings.setHostSessionsEnabled(true);
    await settings.setHostSessionsProject(repo, 'deny');
    d = await settings.hostProjectDecisions([{ folder: repo }]);
    expect(d.enabled).toBe(true);
    expect(d.projects[0]).toMatchObject({ mode: 'deny', allowed: false, reason: 'project' });

    await settings.setHostSessionsProject(repo, 'inherit');
    d = await settings.hostProjectDecisions([{ folder: repo }]);
    expect(d.projects[0]).toMatchObject({ mode: 'inherit', allowed: true, reason: 'global' });
  });
});
