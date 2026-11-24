import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The plugin and extension are plain .js files baked into the box image and
// loaded by opencode / pi, so they are imported by URL rather than as modules
// of this package.
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

interface Report {
  state: string;
  sessionId?: string | null;
  session?: { id: string; file: string } | null;
}
type Tracker = { handle: (...args: unknown[]) => Report | null };

async function loadOpencodeTracker(): Promise<Tracker> {
  const mod = (await import(pathToFileURL(join(scripts, 'opencode-agentbox-plugin.js')).href)) as {
    AgentboxStatePlugin: { createTracker: () => Tracker };
  };
  return mod.AgentboxStatePlugin.createTracker();
}

async function loadPiTracker(): Promise<Tracker> {
  const mod = (await import(pathToFileURL(join(scripts, 'pi-agentbox-extension.js')).href)) as {
    default: { createTracker: () => Tracker };
  };
  return mod.default.createTracker();
}

const ev = (type: string, properties: Record<string, unknown> = {}) => ({ type, properties });
const status = (sessionID: string, type: string) =>
  ev('session.status', { sessionID, status: { type } });

function states(t: Tracker, events: unknown[]): (string | null)[] {
  return events.map((e) => t.handle(e)?.state ?? null);
}

describe('opencode plugin tracker', () => {
  it('only exports the plugin (opencode calls every export as a plugin)', async () => {
    const mod = (await import(
      pathToFileURL(join(scripts, 'opencode-agentbox-plugin.js')).href
    )) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(['AgentboxStatePlugin']);
  });

  it('reads busy for the whole turn, tool calls included, and idle at the end', async () => {
    const t = await loadOpencodeTracker();
    expect(
      states(t, [
        ev('session.created', { info: { id: 'ses_root' } }),
        status('ses_root', 'busy'),
        ev('message.part.delta', { sessionID: 'ses_root' }),
        status('ses_root', 'busy'),
        ev('session.idle', { sessionID: 'ses_root' }),
      ]),
    ).toEqual(['idle', 'working', null, null, 'idle']);
  });

  it('names the root session that went busy', async () => {
    const t = await loadOpencodeTracker();
    t.handle(ev('session.created', { info: { id: 'ses_a' } }));
    expect(t.handle(status('ses_a', 'busy'))).toEqual({ state: 'working', sessionId: 'ses_a' });
    t.handle(ev('session.idle', { sessionID: 'ses_a' }));
    expect(t.handle(status('ses_b', 'busy'))).toEqual({ state: 'working', sessionId: 'ses_b' });
  });

  it('ignores a subagent session (parentID) so the parent stays working', async () => {
    const t = await loadOpencodeTracker();
    t.handle(status('ses_root', 'busy'));
    expect(
      states(t, [
        ev('session.created', { info: { id: 'ses_child', parentID: 'ses_root' } }),
        status('ses_child', 'busy'),
        ev('session.idle', { sessionID: 'ses_child' }),
        status('ses_child', 'idle'),
      ]),
    ).toEqual([null, null, null, null]);
    expect(t.handle(ev('session.idle', { sessionID: 'ses_root' }))?.state).toBe('idle');
  });

  it('keeps error sticky over the session.idle that follows it, until the next busy', async () => {
    const t = await loadOpencodeTracker();
    expect(
      states(t, [
        status('ses_root', 'busy'),
        ev('session.error', { sessionID: 'ses_root', error: { name: 'UnknownError' } }),
        ev('session.idle', { sessionID: 'ses_root' }),
        status('ses_root', 'idle'),
        status('ses_root', 'busy'),
      ]),
    ).toEqual(['working', 'error', null, null, 'working']);
  });

  it('waits on an unanswered permission, from any session, until it is replied', async () => {
    const t = await loadOpencodeTracker();
    t.handle(status('ses_root', 'busy'));
    expect(
      states(t, [
        ev('permission.asked', { id: 'per_1', sessionID: 'ses_child' }),
        ev('permission.replied', { sessionID: 'ses_child', requestID: 'per_1', reply: 'once' }),
      ]),
    ).toEqual(['waiting', 'working']);
  });

  it('falls back to message.part.delta only on an opencode without session.status', async () => {
    const old = await loadOpencodeTracker();
    expect(old.handle(ev('message.part.delta', { sessionID: 's1' }))?.state).toBe('working');
    const cur = await loadOpencodeTracker();
    cur.handle(status('s1', 'idle'));
    expect(cur.handle(ev('message.part.delta', { sessionID: 's1' }))).toBe(null);
  });
});

describe('pi extension tracker', () => {
  const s1 = { id: 'sess-1', file: '/home/vscode/.pi/agent/sessions/a.jsonl' };
  const s2 = { id: 'sess-2', file: '/home/vscode/.pi/agent/sessions/b.jsonl' };

  it('only has a default export', async () => {
    const mod = (await import(
      pathToFileURL(join(scripts, 'pi-agentbox-extension.js')).href
    )) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(['default']);
  });

  it('goes idle on agent_settled, not agent_end', async () => {
    const t = await loadPiTracker();
    const run = (name: string, event: unknown = {}) => t.handle(name, event, s1)?.state ?? null;
    expect([
      run('session_start'),
      run('agent_start'),
      run('tool_execution_start'),
      run('message_end', { message: { role: 'assistant', stopReason: 'stop' } }),
      run('agent_end'),
      run('agent_settled'),
    ]).toEqual(['idle', 'working', null, null, null, 'idle']);
  });

  it('waits on a ui prompt', async () => {
    const t = await loadPiTracker();
    t.handle('agent_start', {}, s1);
    expect(t.handle('ui_prompt_start', {}, s1)?.state).toBe('waiting');
    expect(t.handle('ui_prompt_end', {}, s1)?.state).toBe('working');
  });

  it('reports a stopReason error and keeps it over the settle', async () => {
    const t = await loadPiTracker();
    t.handle('agent_start', {}, s1);
    expect(
      t.handle('message_end', { message: { role: 'assistant', stopReason: 'error' } }, s1)?.state,
    ).toBe('error');
    expect(t.handle('agent_settled', {}, s1)).toBe(null);
    expect(t.handle('agent_start', {}, s1)?.state).toBe('working');
  });

  it('carries the session, and reports a session switch even when the state is unchanged', async () => {
    const t = await loadPiTracker();
    expect(t.handle('session_start', {}, s1)).toEqual({ state: 'idle', session: s1 });
    expect(t.handle('session_start', { reason: 'new' }, s2)).toEqual({
      state: 'idle',
      session: s2,
    });
  });
});
