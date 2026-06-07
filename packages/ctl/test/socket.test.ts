import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/socket.js';
import { Supervisor } from '../src/supervisor.js';
import { claudeSession, ping, status, taskStatus, waitReady, logs } from '../src/client.js';
import type { ServiceSpec } from '../src/config.js';
import type { Server } from 'node:net';

const NODE = process.execPath;

function spec(
  over: Partial<ServiceSpec> & { name: string; command: string | string[] },
): ServiceSpec {
  return {
    autostart: true,
    restart: 'on-failure',
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
    needs: [],
    ...over,
  };
}

describe('socket protocol', () => {
  let dir: string;
  let sock: string;
  let server: Server;
  let sup: Supervisor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctl-sock-'));
    sock = join(dir, 'ctl.sock');
    sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init({
      tasks: [],
      replacements: {},
      services: [
        spec({
          name: 'svc',
          command: [NODE, '-e', 'console.log("hi"); setInterval(()=>console.log("tick"),20)'],
        }),
      ],
    });
    server = await startServer({
      socketPath: sock,
      supervisor: sup,
      logDir: dir,
      configPath: join(dir, 'nope.yaml'),
    });
  });

  afterEach(async () => {
    server.close();
    await sup.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('responds to ping', async () => {
    expect(await ping({ socketPath: sock })).toBe('pong');
  });

  it('returns service + task status list', async () => {
    const reply = await status({ socketPath: sock });
    expect(reply.services).toHaveLength(1);
    expect(reply.services[0]!.name).toBe('svc');
    expect(reply.tasks).toHaveLength(0);
    // blockedOn defaults to [] for unblocked services.
    expect(reply.services[0]!.blockedOn).toEqual([]);
    expect(Array.isArray(reply.ports)).toBe(true);
  });

  it('task-status returns the task list', async () => {
    const tasks = await taskStatus({ socketPath: sock });
    expect(tasks).toEqual([]);
  });

  it('wait-ready returns ready=true when the only service is up', async () => {
    // Give the service a tick to enter 'running'.
    await new Promise((r) => setTimeout(r, 100));
    const result = await waitReady({ socketPath: sock }, { timeoutMs: 2000 });
    expect(result.ready).toBe(true);
  });

  it('returns initial log lines without follow', async () => {
    // Poll until the service has emitted at least one line — a cold `node`
    // spawn can take well over 100ms on a loaded CI runner, so a fixed sleep
    // races the process startup.
    const deadline = Date.now() + 2000;
    let result = await logs({ socketPath: sock }, { service: 'svc', tail: 50, follow: false });
    while (
      !result.initial.some((e) => e.line === 'hi' || e.line === 'tick') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
      result = await logs({ socketPath: sock }, { service: 'svc', tail: 50, follow: false });
    }
    expect(result.initial.some((e) => e.line === 'hi' || e.line === 'tick')).toBe(true);
    expect(result.follow).toBeUndefined();
  });

  it('streams new lines when follow=true', async () => {
    const result = await logs({ socketPath: sock }, { service: 'svc', tail: 5, follow: true });
    expect(result.follow).toBeDefined();
    let got = false;
    const deadline = Date.now() + 1500;
    for await (const ev of result.follow!) {
      if (ev.line === 'tick') {
        got = true;
        break;
      }
      if (Date.now() > deadline) break;
    }
    expect(got).toBe(true);
  });

  it('claude-session reports running=false for a non-existent session name', async () => {
    // Random name guarantees no collision with a real tmux session that might
    // happen to be running in this user's env. Whether tmux is installed or
    // not, has-session for a missing name returns non-zero -> running: false.
    const uniqueName = `agentbox-test-${randomBytes(4).toString('hex')}`;
    const result = await claudeSession({ socketPath: sock, sessionName: uniqueName });
    expect(result.running).toBe(false);
    expect(result.sessionName).toBe(uniqueName);
    expect(result.startedAt).toBeNull();
  });
});
