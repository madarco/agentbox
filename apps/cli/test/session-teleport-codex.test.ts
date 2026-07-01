import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexTeleport } from '../src/session-teleport/codex.js';
import { TeleportError } from '../src/session-teleport/types.js';

const HOST_CWD = '/Users/marco/Projects/AgentBox/agentbox';

function metaLine(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-05-03T18:07:09.614Z',
    type: 'session_meta',
    payload: { id, timestamp: '2026-05-03T18:07:09.576Z', cwd },
  });
}

// Codex writes one of these per turn; the latest cwd drives the resume prompt.
// Mirrors the real shape: cwd, workspace_roots, and nested sandbox-policy paths.
function turnContextLine(cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-05-03T18:08:00.000Z',
    type: 'turn_context',
    payload: {
      turn_id: 'turn-1',
      cwd,
      workspace_roots: [cwd],
      permission_profile: {
        file_system: { entries: [{ path: { path: `${cwd}/.git` } }] },
      },
      file_system_sandbox_policy: { entries: [{ path: { path: cwd } }] },
    },
  });
}

// Freeform transcript content — must be preserved byte-for-byte even though it
// mentions the host path.
function responseItemLine(cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-05-03T18:08:01.000Z',
    type: 'response_item',
    payload: { role: 'assistant', content: [{ type: 'text', text: `I ran ls in ${cwd}` }] },
  });
}

async function seedCodexSession(
  hostHome: string,
  rel: { year: string; month: string; day: string; filename: string },
  lines: string[],
  mtimeMs: number,
): Promise<string> {
  const dir = join(hostHome, '.codex', 'sessions', rel.year, rel.month, rel.day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, rel.filename);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  const t = new Date(mtimeMs);
  await utimes(file, t, t);
  return file;
}

describe('resolveCodexTeleport', () => {
  it('errors when ~/.codex/sessions does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    await expect(
      resolveCodexTeleport({
        hostCwd: HOST_CWD,
        mode: { kind: 'continue' },
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });

  it('picks newest session matching cwd for -c', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    const idOld = '019def05-d305-7453-9483-fa1b3fda5b8c';
    const idNew = '019def05-d305-7453-9483-aaaaaaaaaaaa';
    const idOther = '019def05-d305-7453-9483-bbbbbbbbbbbb';
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '03',
        filename: `rollout-2026-05-03T19-07-09-${idOld}.jsonl`,
      },
      [metaLine(idOld, HOST_CWD)],
      1_000_000_000_000,
    );
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '04',
        filename: `rollout-2026-05-04T08-00-00-${idNew}.jsonl`,
      },
      [metaLine(idNew, HOST_CWD)],
      1_700_000_000_000,
    );
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '05',
        filename: `rollout-2026-05-05T08-00-00-${idOther}.jsonl`,
      },
      [metaLine(idOther, '/some/other/path')],
      1_800_000_000_000, // newest overall, but cwd mismatch
    );

    const r = await resolveCodexTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'continue' },
      hostHome: home,
    });
    expect(r.sessionId).toBe(idNew);
    expect(r.forwardArgs).toEqual(['resume', idNew]);
    expect(r.boxPath).toBe(
      `/home/vscode/.codex/sessions/2026/05/04/rollout-2026-05-04T08-00-00-${idNew}.jsonl`,
    );

    const rewritten = await readFile(r.hostFile, 'utf8');
    expect(rewritten).toContain('"cwd":"/workspace"');
    expect(rewritten).not.toContain(HOST_CWD);
  });

  it('rewrites cwd in turn_context records but leaves transcript intact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    const id = '019def05-d305-7453-9483-feedfeedfeed';
    const responseLine = responseItemLine(HOST_CWD);
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '03',
        filename: `rollout-2026-05-03T19-07-09-${id}.jsonl`,
      },
      [metaLine(id, HOST_CWD), turnContextLine(HOST_CWD), responseLine],
      1_000_000_000_000,
    );

    const r = await resolveCodexTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'continue' },
      hostHome: home,
    });

    const rewritten = await readFile(r.hostFile, 'utf8');
    const lines = rewritten.split('\n').filter((l) => l.length > 0);
    const meta = JSON.parse(lines[0]!);
    const turn = JSON.parse(lines[1]!);

    // session_meta + turn_context cwd/paths rewritten to the box workspace.
    expect(meta.payload.cwd).toBe('/workspace');
    expect(turn.payload.cwd).toBe('/workspace');
    expect(turn.payload.workspace_roots).toEqual(['/workspace']);
    expect(turn.payload.permission_profile.file_system.entries[0].path.path).toBe('/workspace/.git');
    expect(turn.payload.file_system_sandbox_policy.entries[0].path.path).toBe('/workspace');

    // The response_item transcript line is preserved verbatim (host path intact).
    expect(lines[2]).toBe(responseLine);
    expect(lines[2]).toContain(HOST_CWD);
  });

  it('errors when no codex session has a matching cwd for -c', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    const id = '019def05-d305-7453-9483-cccccccccccc';
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '03',
        filename: `rollout-2026-05-03T19-07-09-${id}.jsonl`,
      },
      [metaLine(id, '/some/other/path')],
      1_000_000_000_000,
    );
    await expect(
      resolveCodexTeleport({
        hostCwd: HOST_CWD,
        mode: { kind: 'continue' },
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });

  it('resolves --resume <uuid> and rewrites even on cwd mismatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    const id = '019def05-d305-7453-9483-dddddddddddd';
    await seedCodexSession(
      home,
      {
        year: '2026',
        month: '05',
        day: '03',
        filename: `rollout-2026-05-03T19-07-09-${id}.jsonl`,
      },
      [metaLine(id, '/totally/different/cwd')],
      1_000_000_000_000,
    );
    const logs: string[] = [];
    const r = await resolveCodexTeleport({
      hostCwd: HOST_CWD,
      mode: { kind: 'resume', id },
      hostHome: home,
      log: (line) => logs.push(line),
    });
    expect(r.sessionId).toBe(id);
    expect(logs.some((l) => l.includes('WARN codex session'))).toBe(true);
  });

  it('errors cleanly on unknown --resume id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'teleport-codex-'));
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
    await expect(
      resolveCodexTeleport({
        hostCwd: HOST_CWD,
        mode: { kind: 'resume', id: '019def05-d305-7453-9483-eeeeeeeeeeee' },
        hostHome: home,
      }),
    ).rejects.toBeInstanceOf(TeleportError);
  });
});
