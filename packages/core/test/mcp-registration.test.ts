import { describe, expect, it } from 'vitest';
import {
  applyMcpRegistration,
  parseAgentMcpSpec,
  removeMcpRegistration,
} from '../src/index.js';

const claude = { format: 'json', serversPath: ['mcpServers'], entry: 'stdio' } as const;
const codex = { format: 'toml', serversPath: ['mcp_servers'], entry: 'stdio' } as const;
const opencode = { format: 'json', serversPath: ['mcp'], entry: 'opencode' } as const;

describe('applyMcpRegistration', () => {
  it('adds the agentbox server and keeps everything else', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'x' } } });
    const r = applyMcpRegistration(before, claude);
    expect(r.ok && r.changed).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.text)).toEqual({
      theme: 'dark',
      mcpServers: {
        mine: { command: 'x' },
        agentbox: { type: 'stdio', command: 'agentbox-ctl', args: ['mcp'] },
      },
    });
    const again = applyMcpRegistration(r.text, claude);
    expect(again).toEqual({ ok: true, changed: false, text: r.text });
  });

  it('creates a missing file and the opencode entry shape', () => {
    const r = applyMcpRegistration(null, opencode);
    expect(r.ok && JSON.parse(r.text)).toEqual({
      mcp: { agentbox: { type: 'local', command: ['agentbox-ctl', 'mcp'], enabled: true } },
    });
  });

  it('corrects a stale entry and refuses a file it cannot parse', () => {
    const stale = JSON.stringify({ mcpServers: { agentbox: { command: 'old' } } });
    expect(applyMcpRegistration(stale, claude)).toMatchObject({ ok: true, changed: true });
    expect(applyMcpRegistration('{ // jsonc', claude).ok).toBe(false);
    expect(applyMcpRegistration('[]', claude).ok).toBe(false);
    expect(applyMcpRegistration('{"mcpServers": 3}', claude).ok).toBe(false);
  });

  it('appends a codex TOML table once', () => {
    const r = applyMcpRegistration('model = "o3"', codex);
    expect(r.ok && r.text).toBe(
      'model = "o3"\n\n[mcp_servers.agentbox]\ncommand = "agentbox-ctl"\nargs = ["mcp"]\n',
    );
    if (!r.ok) return;
    expect(applyMcpRegistration(r.text, codex)).toMatchObject({ ok: true, changed: false });
    // A table the user wrote is left alone.
    const own = '[mcp_servers.agentbox]\ncommand = "custom"\n';
    expect(applyMcpRegistration(own, codex)).toEqual({ ok: true, changed: false, text: own });
    expect(applyMcpRegistration(null, codex)).toMatchObject({ ok: true, changed: true });
  });
});

describe('parseAgentMcpSpec', () => {
  it('accepts the built-in shapes and drops malformed or unsafe ones', () => {
    const ok = {
      file: '~/.claude.json',
      format: 'json',
      serversPath: ['mcpServers'],
      entry: 'stdio',
    };
    expect(parseAgentMcpSpec(ok)).toEqual(ok);
    expect(parseAgentMcpSpec({ ...ok, file: 'rel/path.json' })).toBeNull();
    expect(parseAgentMcpSpec({ ...ok, file: '~/../etc/x' })).toBeNull();
    expect(parseAgentMcpSpec({ ...ok, format: 'yaml' })).toBeNull();
    expect(parseAgentMcpSpec({ ...ok, serversPath: [] })).toBeNull();
    expect(parseAgentMcpSpec({ ...ok, entry: 'http' })).toBeNull();
    expect(parseAgentMcpSpec(null)).toBeNull();
  });
});

describe('codex TOML spellings', () => {
  it('sees an existing agentbox server however it is written, and never duplicates it', () => {
    for (const text of [
      '[mcp_servers."agentbox"]\ncommand = "x"\n',
      "[mcp_servers.'agentbox']\ncommand = 'x'\n",
      '[mcp_servers.agentbox.env]\nA = "1"\n',
      'mcp_servers.agentbox.command = "x"\n',
      'mcp_servers = { agentbox = { command = "x" } }\n',
      '[mcp_servers]\nagentbox = { command = "x" }\n',
      '[mcp_servers] # mine\n"agentbox".command = "x"\n',
    ]) {
      expect(applyMcpRegistration(text, codex), text).toMatchObject({ changed: false, text });
    }
    // A different server, or agentbox under another table, does not count.
    expect(applyMcpRegistration('[mcp_servers.other]\ncommand = "x"\n', codex)).toMatchObject({
      changed: true,
    });
    expect(applyMcpRegistration('[profiles]\nagentbox = "x"\n', codex)).toMatchObject({
      changed: true,
    });
  });
});

describe('removeMcpRegistration', () => {
  it('takes out exactly the entry ctl wrote, and nothing a user wrote', () => {
    const added = applyMcpRegistration('model = "o3"\n', codex);
    if (!added.ok) throw new Error('add failed');
    expect(removeMcpRegistration(added.text, codex)).toEqual({
      changed: true,
      text: 'model = "o3"\n',
    });
    const own = '[mcp_servers.agentbox]\ncommand = "custom"\n';
    expect(removeMcpRegistration(own, codex).changed).toBe(false);
    const json = applyMcpRegistration('{"mcpServers":{"mine":{"command":"x"}}}', claude);
    if (!json.ok) throw new Error('add failed');
    const out = removeMcpRegistration(json.text, claude);
    expect(out.changed && JSON.parse(out.text)).toEqual({ mcpServers: { mine: { command: 'x' } } });
    const custom = '{"mcpServers":{"agentbox":{"command":"mine"}}}';
    expect(removeMcpRegistration(custom, claude).changed).toBe(false);
  });
});
