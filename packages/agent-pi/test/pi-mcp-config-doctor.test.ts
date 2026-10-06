import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkExternalPiMcpConfigs } from '../src/doctor.js';

const homes: string[] = [];

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agentbox-pi-mcp-'));
  homes.push(home);
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('external Pi MCP config doctor check', () => {
  it('reports counts and fixed paths without exposing names or credentials', async () => {
    const home = await fakeHome();
    await mkdir(join(home, '.config', 'mcp'), { recursive: true });
    await writeFile(
      join(home, '.config', 'mcp', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          privateServerName: { command: 'secret-command', env: { TOKEN: 'literal-secret' } },
        },
      }),
    );
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          '/private/project': {
            mcpServers: { anotherPrivateName: { env: { API_KEY: 'another-secret' } } },
          },
        },
      }),
    );

    const result = await checkExternalPiMcpConfigs(home);
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ label: 'pi MCP config', status: 'warn' });
    expect(result?.detail).toContain('~/.config/mcp/mcp.json (1)');
    expect(result?.detail).toContain('~/.claude.json (1)');
    for (const sensitive of [
      'privateServerName',
      'anotherPrivateName',
      'secret-command',
      'literal-secret',
      'another-secret',
      '/private/project',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it('stays silent when external files have no MCP declarations', async () => {
    const home = await fakeHome();
    await writeFile(join(home, '.claude.json'), JSON.stringify({ projects: {} }));
    await expect(checkExternalPiMcpConfigs(home)).resolves.toBeNull();
  });

  it('stays silent when Pi is not configured on the host', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-no-pi-'));
    homes.push(home);
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { server: { env: { TOKEN: 'secret' } } } }),
    );
    await expect(checkExternalPiMcpConfigs(home)).resolves.toBeNull();
  });
});
