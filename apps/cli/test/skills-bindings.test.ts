import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Scratch HOME before the imports: workspace matching reads this machine's id.
const home = mkdtempSync(join(tmpdir(), 'agentbox-skill-bindings-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { renderBindings, resolveBindingTarget } = await import('../src/commands/skills-bindings.js');

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const WS = {
  id: 'a1b2c3d4e5f60718',
  name: 'acme',
  projects: [],
  hosts: {},
  projectIds: [],
  createdAt: '',
  updatedAt: '',
};
const client = { listWorkspaces: async () => [WS] } as never;
const keyOf = async (u: string) => (u.includes('acme/app') ? 'github.com/acme/app' : undefined);

describe('skills enable|disable target', () => {
  it('defaults to global', async () => {
    expect(await resolveBindingTarget(client, {})).toEqual({ scope: 'global' });
  });

  it('keys --project by the cwd origin, or an explicit url', async () => {
    expect(
      await resolveBindingTarget(
        client,
        { project: true },
        { origin: async () => 'git@github.com:acme/app.git', keyOf },
      ),
    ).toEqual({ scope: 'project', scopeId: 'github.com/acme/app' });
    expect(
      await resolveBindingTarget(client, { project: 'https://github.com/acme/app' }, { keyOf }),
    ).toEqual({ scope: 'project', scopeId: 'github.com/acme/app' });
    await expect(
      resolveBindingTarget(client, { project: true }, { origin: async () => undefined }),
    ).rejects.toThrow(/no git origin/);
    await expect(
      resolveBindingTarget(client, { project: '/srv/x' }, { keyOf: async () => 'local:m:/srv/x' }),
    ).rejects.toThrow(/not a remote/);
  });

  it('resolves --workspace by id or name, and refuses an unknown one', async () => {
    expect(await resolveBindingTarget(client, { workspace: 'acme' }, { env: {} })).toEqual({
      scope: 'workspace',
      scopeId: WS.id,
    });
    expect(
      await resolveBindingTarget(
        client,
        { workspace: true },
        { env: { AGENTBOX_WORKSPACE: WS.id } },
      ),
    ).toEqual({ scope: 'workspace', scopeId: WS.id });
    await expect(resolveBindingTarget(client, { workspace: 'nope' }, { env: {} })).rejects.toThrow(
      /no workspace 'nope'/,
    );
    await expect(
      resolveBindingTarget(client, { workspace: true }, { env: {}, cwd: home }),
    ).rejects.toThrow(/not in a workspace/);
    await expect(resolveBindingTarget(client, { project: true, workspace: true })).rejects.toThrow(
      /not both/,
    );
  });

  it('renders the bindings table', () => {
    const text = renderBindings(
      {
        schema: 1,
        global: { alpha: 'exclude' },
        workspace: { [WS.id]: { alpha: 'include' } },
        project: {},
        box: {},
      },
      { workspace: new Map([[WS.id, 'acme']]) },
    );
    expect(text).toContain('global     -                        alpha  exclude');
    expect(text).toContain(`workspace  acme (${WS.id})  alpha  include`);
    expect(renderBindings({ schema: 1, global: {}, workspace: {}, project: {}, box: {} })).toMatch(
      /No skill bindings/,
    );
  });
});
