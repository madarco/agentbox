import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runMcpBridge, type McpForward } from '../src/mcp-bridge.js';
import { registerBoxMcp } from '../src/mcp-register.js';

async function bridge(lines: string[], forward: McpForward): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c: Buffer) => (out += c.toString()));
  const done = runMcpBridge({ input, output, forward });
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  await done;
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

describe('agentbox-ctl mcp (stdio bridge)', () => {
  it('forwards each message and writes the replies, nothing for a notification', async () => {
    const seen: unknown[] = [];
    const out = await bridge(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ],
      async (m) => {
        seen.push(m);
        const id = (m as { id?: number }).id;
        return id === undefined ? null : { jsonrpc: '2.0', id, result: {} };
      },
    );
    expect(seen).toHaveLength(2);
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('answers a parse error, and a transport failure as an error for requests only', async () => {
    const out = await bridge(
      [
        '{not json',
        JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
      ],
      async () => {
        throw new Error('the AgentBox relay did not answer (exit 126)');
      },
    );
    expect(out).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      {
        jsonrpc: '2.0',
        id: 'a',
        error: { code: -32603, message: 'the AgentBox relay did not answer (exit 126)' },
      },
    ]);
  });
});

describe('registerBoxMcp', () => {
  it("writes each agent's file, through a symlink, and is idempotent", async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcp-reg-'));
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude', '_claude.json'), JSON.stringify({ theme: 'dark' }));
    await symlink(join(home, '.claude', '_claude.json'), join(home, '.claude.json'));
    const targets = [
      { agent: 'claude', file: '~/.claude.json', format: 'json', serversPath: ['mcpServers'], entry: 'stdio' },
      { agent: 'codex', file: '~/.codex/config.toml', format: 'toml', serversPath: ['mcp_servers'], entry: 'stdio' },
    ] as const;
    const first = await registerBoxMcp(targets, { home });
    expect(first.map((r) => r.outcome)).toEqual(['added', 'added']);
    const claude = JSON.parse(await readFile(join(home, '.claude', '_claude.json'), 'utf8'));
    expect(claude).toEqual({
      theme: 'dark',
      mcpServers: { agentbox: { type: 'stdio', command: 'agentbox-ctl', args: ['mcp'] } },
    });
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.agentbox]',
    );
    const second = await registerBoxMcp(targets, { home });
    expect(second.map((r) => r.outcome)).toEqual(['present', 'present']);
  });

  it('leaves a file it cannot parse alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcp-reg-'));
    await writeFile(join(home, '.claude.json'), '{ broken');
    const [r] = await registerBoxMcp(
      [{ agent: 'claude', file: '~/.claude.json', format: 'json', serversPath: ['mcpServers'], entry: 'stdio' }],
      { home },
    );
    expect(r!.outcome).toBe('skipped');
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{ broken');
  });
});
