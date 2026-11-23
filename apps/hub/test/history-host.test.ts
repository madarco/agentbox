import { describe, expect, it } from 'vitest';
import { createHostSessionsBackend, parseHostSessionsPatch } from '../lib/backend/history-host';

describe('PUT /history/host body', () => {
  it('accepts enabled and/or one project', () => {
    expect(parseHostSessionsPatch({ enabled: true })).toEqual({ ok: true, value: { enabled: true } });
    expect(parseHostSessionsPatch({ project: { folder: '/a/b', mode: 'deny' } })).toEqual({
      ok: true,
      value: { project: { folder: '/a/b', mode: 'deny' } },
    });
  });

  it('refuses an empty patch, a relative folder, or an unknown mode', () => {
    expect(parseHostSessionsPatch({}).ok).toBe(false);
    expect(parseHostSessionsPatch({ enabled: 'yes' }).ok).toBe(false);
    expect(parseHostSessionsPatch({ project: { folder: 'a/b', mode: 'allow' } }).ok).toBe(false);
    expect(parseHostSessionsPatch({ project: { folder: '/a', mode: 'maybe' } }).ok).toBe(false);
  });
});

describe('host sessions backend', () => {
  it('writes the toggle and the project, then answers the fresh view', async () => {
    const calls: string[] = [];
    let enabled = false;
    const backend = createHostSessionsBackend({
      folders: async () => [{ folder: '/p' }],
      decide: async (fs) => ({
        enabled,
        projects: fs.map((f) => ({
          folder: f.folder,
          mode: 'inherit' as const,
          allowed: enabled,
          reason: enabled ? ('global' as const) : ('off' as const),
        })),
      }),
      status: async () => null,
      setEnabled: async (v) => {
        calls.push(`enabled=${String(v)}`);
        enabled = v;
      },
      setProject: async (f, m) => {
        calls.push(`${f}=${m}`);
        return f;
      },
    });
    const v = await backend.update({ enabled: true, project: { folder: '/p', mode: 'deny' } });
    expect(calls).toEqual(['enabled=true', '/p=deny']);
    expect(v).toMatchObject({ enabled: true, projects: [{ folder: '/p', allowed: true }], status: null });
  });
});
