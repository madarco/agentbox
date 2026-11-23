import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubSecretsOnHost, stripHubMcpServers } from '../src/hooks-filter.js';
import { stageClaudeJsonOnlyForUpload } from '../src/host-stage.js';

const TOKEN = 'hubtoken-0123456789abcdef';

const hostJson = {
  theme: 'dark',
  mcpServers: {
    agentbox: {
      type: 'http',
      url: 'http://127.0.0.1:8787/api/mcp',
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
    remote: { type: 'http', url: 'https://hub.example.com/api/mcp' },
    viaStdio: { type: 'stdio', command: 'agentbox', args: ['mcp'] },
    other: { type: 'stdio', command: 'npx', args: ['some-mcp'] },
  },
  projects: {
    '/Users/me/proj': {
      hasTrustDialogAccepted: true,
      mcpServers: {
        leaky: { type: 'sse', url: 'http://x:9/sse', headers: { 'x-token': TOKEN } },
        fine: { type: 'stdio', command: 'node', args: ['srv.js'] },
      },
    },
  },
};

describe('stripHubMcpServers', () => {
  it('drops servers carrying the hub token or pointing at a hub /api/mcp, top-level and per project', () => {
    const r = stripHubMcpServers(structuredClone(hostJson), [TOKEN]);
    expect(r.removed.sort()).toEqual(['/Users/me/proj:leaky', 'agentbox', 'remote']);
    const d = r.data as typeof hostJson;
    expect(Object.keys(d.mcpServers)).toEqual(['viaStdio', 'other']);
    expect(Object.keys(d.projects['/Users/me/proj'].mcpServers)).toEqual(['fine']);
    expect(d.projects['/Users/me/proj'].hasTrustDialogAccepted).toBe(true);
  });

  it('leaves a config with nothing to strip as the same object', () => {
    const clean = { mcpServers: { other: { command: 'x' } } };
    const r = stripHubMcpServers(clean, [TOKEN]);
    expect(r.removed).toEqual([]);
    expect(r.data).toBe(clean);
  });

  it('reads the local hub token and the hub env credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hub-sec-'));
    await mkdir(join(home, '.agentbox', 'hub'), { recursive: true });
    await writeFile(join(home, '.agentbox', 'hub', 'token'), `${TOKEN}\n`);
    expect(hubSecretsOnHost(home, { AGENTBOX_HUB_API_KEY: 'apikey-xyz-123456' })).toEqual([
      TOKEN,
      'apikey-xyz-123456',
    ]);
  });
});

describe('cloud _claude.json staging', () => {
  it("never carries the host's hub MCP credential into a box", async () => {
    const home = await mkdtemp(join(tmpdir(), 'hub-stage-'));
    await mkdir(join(home, '.agentbox', 'hub'), { recursive: true });
    await writeFile(join(home, '.agentbox', 'hub', 'token'), TOKEN);
    await writeFile(join(home, '.claude.json'), JSON.stringify(hostJson));
    const staged = await stageClaudeJsonOnlyForUpload({ hostHome: home });
    const out = await mkdtemp(join(tmpdir(), 'hub-stage-out-'));
    execFileSync('tar', ['-xzf', staged.tarballPath!, '-C', out]);
    const text = await readFile(join(out, '_claude.json'), 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('/api/mcp');
    expect(Object.keys((JSON.parse(text) as typeof hostJson).mcpServers)).toEqual([
      'viaStdio',
      'other',
    ]);
    await staged.cleanup?.();
  });
});

describe('docker config-volume seed filter', () => {
  it('writes a filtered _claude.json without the hub MCP credential', async () => {
    const { maybeFilterTo } = await import('../src/claude-json-filter.js');
    const dir = await mkdtemp(join(tmpdir(), 'hub-docker-'));
    await writeFile(join(dir, 'src.json'), JSON.stringify(hostJson));
    const r = await maybeFilterTo(
      join(dir, 'src.json'),
      join(dir, 'out.json'),
      '/nonexistent-home',
      {
        stripHubMcp: [TOKEN],
      },
    );
    expect(r).toBeDefined();
    const text = await readFile(join(dir, 'out.json'), 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('/api/mcp');
  });
});
