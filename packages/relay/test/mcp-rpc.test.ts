import { describe, expect, it } from 'vitest';
import type { McpBoxScope } from '@agentbox/core';
import { executeCloudAction } from '../src/host-actions.js';
import { runMcpRpc } from '../src/mcp-rpc.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';

const scope: McpBoxScope = {
  kind: 'box',
  boxId: 'b1',
  boxName: 'smoke',
  repoKey: 'github.com/o/r',
  origin: { boxId: 'b1' },
  approve: async () => false,
  redact: async (b) => b,
};
const parse = (stdout: string) => JSON.parse(stdout) as { message: unknown };

describe('runMcpRpc', () => {
  it("hands the message and the box's scope to the hub", async () => {
    const seen: unknown[] = [];
    const r = await runMcpRpc(
      async (s, m) => {
        seen.push([s.boxId, s.repoKey, m]);
        return { jsonrpc: '2.0', id: 1, result: {} };
      },
      async () => scope,
      'mcp.message',
      { message: { jsonrpc: '2.0', id: 1, method: 'ping' } },
    );
    expect(r.exitCode).toBe(0);
    expect(parse(r.stdout).message).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(seen).toEqual([['b1', 'github.com/o/r', { jsonrpc: '2.0', id: 1, method: 'ping' }]]);
  });

  it('answers a JSON-RPC error without a hub, and nothing for a notification', async () => {
    const req = await runMcpRpc(null, async () => scope, 'mcp.message', {
      message: { jsonrpc: '2.0', id: 7, method: 'initialize' },
    });
    expect(parse(req.stdout).message).toMatchObject({ id: 7, error: { code: -32601 } });
    const note = await runMcpRpc(null, async () => scope, 'mcp.message', {
      message: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(parse(note.stdout).message).toBeNull();
  });

  it('turns a handler failure into an internal error and refuses other methods', async () => {
    const r = await runMcpRpc(
      async () => {
        throw new Error('db closed');
      },
      async () => scope,
      'mcp.message',
      { message: { jsonrpc: '2.0', id: 'x', method: 'tools/list' } },
    );
    expect(parse(r.stdout).message).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32603, message: 'db closed' },
    });
    expect((await runMcpRpc(null, async () => scope, 'mcp.other', {})).exitCode).toBe(64);
  });
});

describe('cloud executor', () => {
  it('routes a parked mcp.* action to the bound handler', async () => {
    const action = {
      id: 'a1',
      boxId: 'b1',
      method: 'mcp.message',
      params: { message: { jsonrpc: '2.0', id: 1, method: 'ping' } },
      createdAt: new Date().toISOString(),
    };
    const base = {
      backendName: 'fake',
      boxId: 'b1',
      boxName: 'smoke',
      prompts: new PendingPrompts(),
      subscribers: new PromptSubscribers(),
      log: () => {},
    };
    const r = await executeCloudAction(action, {
      ...base,
      mcp: (method, params) =>
        runMcpRpc(
          async (_s, m) => ({ echo: m }),
          async () => scope,
          method,
          params,
        ),
    });
    expect(parse(r.stdout).message).toEqual({ echo: action.params.message });
    expect((await executeCloudAction(action, base)).exitCode).toBe(64);
  });
});
