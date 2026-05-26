import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClaudeTeleport } from '../src/session-teleport/claude.js';
import { encodeClaudeProjectsDir } from '../src/session-teleport/cwd-encoding.js';
import { TeleportError } from '../src/session-teleport/types.js';

async function seedClaudeProject(
  hostHome: string,
  hostCwd: string,
  sessions: Array<{ id: string; mtimeMs: number; lines: string[] }>,
): Promise<string> {
  const dir = join(hostHome, '.claude', 'projects', encodeClaudeProjectsDir(hostCwd));
  await mkdir(dir, { recursive: true });
  for (const s of sessions) {
    const file = join(dir, `${s.id}.jsonl`);
    await writeFile(file, s.lines.join('\n') + '\n', 'utf8');
    const t = new Date(s.mtimeMs);
    await utimes(file, t, t);
  }
  return dir;
}

const HOST_CWD = '/Users/marco/Projects/AgentBox/agentbox';
const SAMPLE_LINE = (id: string) =>
  JSON.stringify({
    type: 'attachment',
    uuid: 'aaa',
    cwd: HOST_CWD,
    sessionId: id,
    gitBranch: 'main',
  });

describe('resolveClaudeTeleport', () => {
  it('errors when no Claude history exists for the host cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    await expect(
      resolveClaudeTeleport({
        hostCwd: HOST_CWD,
        mode: { kind: 'continue' },
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });

  it('picks the newest session for -c and rewrites cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    await seedClaudeProject(home, HOST_CWD, [
      { id: 'older', mtimeMs: 1_000_000_000_000, lines: [SAMPLE_LINE('older')] },
      { id: 'newer', mtimeMs: 1_700_000_000_000, lines: [SAMPLE_LINE('newer')] },
    ]);

    const r = await resolveClaudeTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'continue' },
      hostHome: home,
    });

    expect(r.sessionId).toBe('newer');
    expect(r.forwardArgs).toEqual(['--resume', 'newer']);
    expect(r.boxPath).toBe('/home/vscode/.claude/projects/-workspace/newer.jsonl');

    const rewritten = await readFile(r.hostFile, 'utf8');
    expect(rewritten).toContain('"cwd":"/workspace"');
    expect(rewritten).not.toContain(HOST_CWD);
  });

  it('resolves --resume <id> directly when the file exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    await seedClaudeProject(home, HOST_CWD, [
      { id: 'older', mtimeMs: 1_000_000_000_000, lines: [SAMPLE_LINE('older')] },
      { id: 'target', mtimeMs: 1_100_000_000_000, lines: [SAMPLE_LINE('target')] },
    ]);
    const r = await resolveClaudeTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'resume', id: 'older' },
      hostHome: home,
    });
    expect(r.sessionId).toBe('older');
    expect(r.forwardArgs).toEqual(['--resume', 'older']);
  });

  it('errors cleanly when --resume <id> file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    await seedClaudeProject(home, HOST_CWD, [
      { id: 'real', mtimeMs: 1_000_000_000_000, lines: [SAMPLE_LINE('real')] },
    ]);
    await expect(
      resolveClaudeTeleport({
        hostCwd: HOST_CWD,
        mode: { kind: 'resume', id: 'nonexistent' },
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });

  it('leaves non-cwd lines untouched', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    const noisyLine = JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: { trackedFileBackups: {} },
    });
    await seedClaudeProject(home, HOST_CWD, [
      { id: 'a', mtimeMs: 1_000, lines: [noisyLine, SAMPLE_LINE('a')] },
    ]);
    const r = await resolveClaudeTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'continue' },
      hostHome: home,
    });
    const lines = (await readFile(r.hostFile, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe(noisyLine); // unchanged
    expect(lines[1]).toContain('"cwd":"/workspace"');
  });

  it('preserves malformed lines verbatim', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-test-'));
    const garbled = '{not json';
    await seedClaudeProject(home, HOST_CWD, [
      { id: 'g', mtimeMs: 1_000, lines: [garbled, SAMPLE_LINE('g')] },
    ]);
    const r = await resolveClaudeTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'continue' },
      hostHome: home,
    });
    const lines = (await readFile(r.hostFile, 'utf8')).split('\n');
    expect(lines[0]).toBe(garbled);
  });
});
