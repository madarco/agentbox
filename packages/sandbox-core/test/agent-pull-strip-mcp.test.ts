import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMcpRegistration, type SyncTransport } from '@agentbox/core';
import { agentPull, registerAgentPullModule } from '../src/sync/agent-pull-module.js';

const codexMcp = { format: 'toml', serversPath: ['mcp_servers'], entry: 'stdio' } as const;

describe('agentPull and the box-only MCP server', () => {
  it("strips ctl's agentbox entry from a config file it just brought to the host", async () => {
    const home = await mkdtemp(join(tmpdir(), 'pull-mcp-'));
    await mkdir(join(home, '.codex'));
    const added = applyMcpRegistration('model = "o3"\n', codexMcp);
    if (!added.ok) throw new Error('add');
    registerAgentPullModule({
      id: 'codex',
      async pull() {
        await writeFile(join(home, '.codex', 'config.toml'), added.text);
        return { newItems: ['config.toml'] };
      },
    });
    const r = await agentPull('codex', {} as SyncTransport, { hostHome: home });
    expect(r.newItems).toEqual(['config.toml']);
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o3"\n');
  });
});
