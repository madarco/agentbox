/**
 * Pi configuration that has to survive the trip into a Docker / Remote Docker
 * box: symlinked skills and mcp.json, and MCP definitions AgentBox
 * deliberately does not copy.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaCalls: Array<{
  file: string;
  args: string[];
  tarEntries: string[];
  tarListing: string;
}> = [];

vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return {
    ...real,
    execa: vi.fn(async (file: string, args: string[], opts?: { inputFile?: string }) => {
      // Only docker is faked; the host-side rsync/tar staging runs for real.
      if (file !== 'docker') return real.execa(file, args, opts as never);
      // Read the piped tarball NOW: the stager deletes it right after the call.
      const tarEntries = opts?.inputFile
        ? execFileSync('tar', ['-tzf', opts.inputFile], { encoding: 'utf8' })
            .split('\n')
            .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
            .filter((l) => l.length > 0 && l !== '.')
        : [];
      const tarListing = opts?.inputFile
        ? execFileSync('tar', ['-tvzf', opts.inputFile], { encoding: 'utf8' })
        : '';
      execaCalls.push({ file, args, tarEntries, tarListing });
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  };
});

vi.mock('@agentbox/sandbox-docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/sandbox-docker')>()),
  volumeExists: vi.fn(async () => true),
  ensureVolume: vi.fn(async () => {}),
}));

const { ensurePiVolume, buildPiVolumeSyncScript } = await import('../src/docker-sync.js');
const { scanPiMcpConfig } = await import('../src/mcp-notice.js');

const TIMEOUT = 30_000;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pi-portable-'));
  execaCalls.length = 0;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeAt(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

describe('docker volume sync of ~/.pi/agent', () => {
  it(
    'streams a host-staged tarball with symlinked skills dereferenced, never mounting the host dir',
    async () => {
      const outside = join(home, 'Users', 'me', 'code', 'skills', 'review');
      await writeAt(join(outside, 'SKILL.md'), 'review skill');
      const pi = join(home, '.pi', 'agent');
      await writeAt(join(pi, 'settings.json'), '{}');
      await writeAt(join(pi, 'auth.json'), '{"anthropic":{"type":"oauth"}}');
      await mkdir(join(pi, 'skills'), { recursive: true });
      await symlink(outside, join(pi, 'skills', 'review'));

      const res = await ensurePiVolume(
        { volume: 'agentbox-pi-config' },
        { syncFromHost: true, image: 'agentbox/box:test', hostHome: home },
      );
      expect(res.synced).toBe(true);

      const run = execaCalls.find((c) => c.file === 'docker' && c.args.includes('-i'));
      expect(run, 'the sync helper reads the tarball from stdin').toBeDefined();
      // The old `-v ~/.pi/agent:/src:ro` is what made the links dangle.
      expect(run!.args.join(' ')).not.toContain(':/src');
      expect(run!.args.join(' ')).not.toContain(pi);
      expect(run!.tarEntries).toContain('skills/review/SKILL.md');
      // A volume IS the credential store, so auth.json rides along here.
      expect(run!.tarEntries).toContain('auth.json');
    },
    TIMEOUT,
  );

  it('unpacks stdin, merges additively, and hands the volume to the box user', () => {
    const script = buildPiVolumeSyncScript();
    expect(script).toContain('tar -xzf - -C "$s"');
    expect(script).toContain('rsync -a "$s"/ /dst/');
    expect(script).not.toContain('--delete');
    expect(script).toMatch(/chown -R vscode:vscode \/dst$/);
  });
});

describe('MCP definitions outside ~/.pi/agent', () => {
  const SECRET = 'sk-live-do-not-print';

  it('says nothing for a plain in-tree mcp.json', async () => {
    await writeAt(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    expect(await scanPiMcpConfig({ hostHome: home })).toEqual({ notices: [] });
  });

  it('reports counts for the shared config and import sources, never names or contents', async () => {
    await writeAt(
      join(home, '.config', 'mcp', 'mcp.json'),
      JSON.stringify({ mcpServers: { gh: { env: { TOKEN: SECRET } } } }),
    );
    await writeAt(
      join(home, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({
        imports: ['claude-code', 'cursor', `x; ${SECRET}`],
        mcpServers: { a: { headers: { Authorization: SECRET } } },
      }),
    );
    const { notices } = await scanPiMcpConfig({ hostHome: home });
    const text = notices.join('\n');
    expect(text).toContain('~/.config/mcp/mcp.json defines 1 MCP server ');
    expect(text).toContain('imports MCP servers from 3 other tool configs');
    // Names are not counts: no server name, no import-source name.
    for (const name of ['gh', 'claude-code', 'cursor', 'TOKEN', 'Authorization']) {
      expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(home);
  });

  it(
    'follows an mcp.json symlinked out of the tree (stow, chezmoi) and says so',
    async () => {
      const elsewhere = join(home, 'dotfiles', 'pi', 'mcp.json');
      await writeAt(elsewhere, JSON.stringify({ mcpServers: { s: { env: { K: SECRET } } } }));
      const pi = join(home, '.pi', 'agent');
      await writeAt(join(pi, 'settings.json'), '{}');
      await symlink(elsewhere, join(pi, 'mcp.json'));

      const scan = await scanPiMcpConfig({ hostHome: home });
      expect(scan.notices.join('\n')).toContain(
        'links to a file outside ~/.pi/agent (1 MCP server); the box gets a copy of that file',
      );
      expect(scan.notices.join('\n')).not.toContain(SECRET);

      await ensurePiVolume(
        { volume: 'agentbox-pi-config' },
        { syncFromHost: true, image: 'agentbox/box:test', hostHome: home },
      );
      const run = execaCalls.find((c) => c.args.includes('-i'));
      expect(run!.tarEntries).toContain('settings.json');
      expect(run!.tarEntries).toContain('mcp.json');
      // A real file in the tarball, not a link that would dangle in the box.
      expect(run!.tarListing).toMatch(/^-.*mcp\.json$/m);
    },
    TIMEOUT,
  );
});
