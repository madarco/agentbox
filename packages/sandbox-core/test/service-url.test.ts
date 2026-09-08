import { describe, expect, it } from 'vitest';
import type { BoxRecord, Provider } from '@agentbox/core';
import {
  readServiceUrlFields,
  serviceAgentForBox,
  serviceSignInUrl,
  withServiceSignIn,
} from '../src/sync/concerns/service-url.js';

const box = { id: 'b1', name: 'ada' } as unknown as BoxRecord;

/** A provider that records what was exec'd and replays canned stdout. */
function fakeProvider(reply: (argv: string[]) => { stdout: string; exitCode?: number }): {
  provider: Provider;
  calls: string[][];
} {
  const calls: string[][] = [];
  const provider = {
    exec: (_b: BoxRecord, argv: string[]) => {
      calls.push(argv);
      const r = reply(argv);
      return Promise.resolve({ stdout: r.stdout, stderr: '', exitCode: r.exitCode ?? 0 });
    },
  } as unknown as Provider;
  return { provider, calls };
}

/** openclaw's real shape, measured on a live box. */
const DASHBOARD_JSON = JSON.stringify({
  ok: true,
  url: 'http://127.0.0.1:18789/#token=09c33b1dcf0bdcde',
  httpUrl: 'http://127.0.0.1:18789/',
  port: 18789,
  tokenIncluded: true,
});

const openclawField = {
  label: 'token',
  command: ['openclaw', 'dashboard', '--json', '--no-open'],
  jsonPath: 'url',
  fromUrlFragment: 'token',
  fragmentKey: 'token',
};

describe('readServiceUrlFields', () => {
  it("runs the agent's own command and lifts the token out of the URL it prints", async () => {
    const { provider, calls } = fakeProvider(() => ({ stdout: DASHBOARD_JSON }));
    const out = await readServiceUrlFields(provider, box, [openclawField]);
    expect(calls).toEqual([['openclaw', 'dashboard', '--json', '--no-open']]);
    expect(out).toEqual([{ label: 'token', value: '09c33b1dcf0bdcde', fragmentKey: 'token' }]);
  });

  it('still supports a plain JSON file for a daemon with no such command', async () => {
    const { provider, calls } = fakeProvider(() => ({
      stdout: JSON.stringify({ gateway: { auth: { token: 'abc' } } }),
    }));
    const out = await readServiceUrlFields(provider, box, [
      { label: 'token', file: '/home/vscode/.x/config.json', jsonPath: 'gateway.auth.token' },
    ]);
    expect(calls).toEqual([['cat', '/home/vscode/.x/config.json']]);
    expect(out[0]?.value).toBe('abc');
  });

  it('tolerates a banner printed before the JSON', async () => {
    // A daemon CLI that greets before it answers must not break the read.
    const { provider } = fakeProvider(() => ({ stdout: `OpenClaw 2026.9.2\n${DASHBOARD_JSON}` }));
    const out = await readServiceUrlFields(provider, box, [openclawField]);
    expect(out[0]?.value).toBe('09c33b1dcf0bdcde');
  });

  it('reads one SOURCE once, however many fields come out of it', async () => {
    let runs = 0;
    const { provider } = fakeProvider(() => {
      runs += 1;
      return { stdout: DASHBOARD_JSON };
    });
    await readServiceUrlFields(provider, box, [
      openclawField,
      { ...openclawField, label: 'port', jsonPath: 'httpUrl', fromUrlFragment: undefined },
    ]);
    expect(runs).toBe(1);
  });

  it('yields nothing when the command fails, so the caller opens the bare URL', async () => {
    // A daemon mid-onboarding has no token yet: that is not an error, and it
    // must not stop the box's web UI from opening at all.
    const { provider } = fakeProvider(() => ({ stdout: '', exitCode: 1 }));
    expect(await readServiceUrlFields(provider, box, [openclawField])).toEqual([]);
  });

  it('yields nothing when the URL carries no such fragment parameter', async () => {
    const { provider } = fakeProvider(() => ({
      stdout: JSON.stringify({ url: 'http://127.0.0.1:18789/' }),
    }));
    expect(await readServiceUrlFields(provider, box, [openclawField])).toEqual([]);
  });

  it('survives stdout that is not JSON at all', async () => {
    const { provider } = fakeProvider(() => ({ stdout: 'command not found' }));
    expect(await readServiceUrlFields(provider, box, [openclawField])).toEqual([]);
  });
});

describe('the two halves together', () => {
  it("grafts the daemon's token onto the HOST's URL, not the box's loopback", async () => {
    // The whole point: openclaw prints 127.0.0.1:18789, which means nothing on
    // the host; the host reaches this box on its own forwarded URL.
    const { provider } = fakeProvider(() => ({ stdout: DASHBOARD_JSON }));
    const values = await readServiceUrlFields(provider, box, [openclawField]);
    expect(serviceSignInUrl('http://127.0.0.1:49870', values)).toBe(
      'http://127.0.0.1:49870/#token=09c33b1dcf0bdcde',
    );
  });
});

describe('serviceAgentForBox', () => {
  it('finds the gateway even when another agent ran last', () => {
    // `agentbox claude` in a bot's box moves `lastAgent` while the gateway keeps
    // running. Reading only that field decides the box has no UI to sign in to,
    // and the dashboard silently goes back to asking for a token.
    expect(serviceAgentForBox({ lastAgent: 'claude', agents: ['openclaw'] })?.id).toBe('openclaw');
  });

  it('finds it from lastAgent alone', () => {
    expect(serviceAgentForBox({ lastAgent: 'openclaw' })?.id).toBe('openclaw');
  });

  it('is undefined for a box that runs no service agent', () => {
    expect(serviceAgentForBox({ lastAgent: 'claude', agents: ['codex'] })).toBeUndefined();
    expect(serviceAgentForBox({})).toBeUndefined();
  });

  it('ignores an agent id nothing in the registry knows', () => {
    expect(serviceAgentForBox({ lastAgent: 'ghost', agents: ['openclaw'] })?.id).toBe('openclaw');
  });
});

describe('withServiceSignIn', () => {
  const bot = { id: 'b1', name: 'ada', lastAgent: 'openclaw' } as unknown as BoxRecord;

  it("signs the URL the VNC desktop's own browser is pointed at", async () => {
    // The in-box browser resolves its own target (the host's forwarded port is
    // nothing inside the box), which is how it ended up as the one surface
    // still opening openclaw on its token prompt.
    const { provider } = fakeProvider(() => ({ stdout: DASHBOARD_JSON }));
    expect(await withServiceSignIn(provider, bot, 'http://localhost:18789')).toBe(
      'http://localhost:18789/#token=09c33b1dcf0bdcde',
    );
  });

  it("leaves an ordinary box's URL alone, without exec'ing into it", async () => {
    const claudeBox = { id: 'b2', name: 'bob', lastAgent: 'claude' } as unknown as BoxRecord;
    const { provider, calls } = fakeProvider(() => ({ stdout: DASHBOARD_JSON }));
    expect(await withServiceSignIn(provider, claudeBox, 'http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(calls).toEqual([]);
  });

  it('falls back to the bare URL when the daemon has no token yet', async () => {
    // Mid-onboard: a sign-in prompt still beats opening nothing.
    const { provider } = fakeProvider(() => ({ stdout: '', exitCode: 1 }));
    expect(await withServiceSignIn(provider, bot, 'http://localhost:18789')).toBe(
      'http://localhost:18789',
    );
  });

  it('falls back to the bare URL when the exec itself throws', async () => {
    const provider = {
      exec: () => Promise.reject(new Error('box is paused')),
    } as unknown as Provider;
    expect(await withServiceSignIn(provider, bot, 'http://localhost:18789')).toBe(
      'http://localhost:18789',
    );
  });
});
