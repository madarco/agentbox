import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { resolveModelAuth } from '../src/lib/model-auth-gate.js';

/**
 * The CLI wrapper's only job beyond the shared gate: turn `--yes` / a missing
 * TTY into "don't ask". The decision itself (flag > config > ask) is covered in
 * packages/sandbox-core/test/model-auth-gate.test.ts.
 */
const openclaw = resolveAgentSpec('openclaw');
const available = async () => [
  {
    agent: 'codex',
    label: 'Your Codex login',
    hostPath: '/home/u/.codex/auth.json',
    boxPath: '/home/vscode/.codex/auth.json',
  },
];

function args(over: Partial<Parameters<typeof resolveModelAuth>[0]> = {}) {
  return {
    spec: openclaw,
    settings: { modelAuth: 'none' } as const,
    sources: {},
    listAvailable: available,
    ...over,
  } as Parameters<typeof resolveModelAuth>[0];
}

describe('resolveModelAuth (CLI wrapper)', () => {
  it('declines rather than asks without a TTY or under --yes', async () => {
    // The asker's fallback for this prompt is `none`, which is also the config
    // default — a scripted create must not hand a subscription token to a daemon.
    expect(await resolveModelAuth(args({ isTTY: false }))).toEqual([]);
    expect(await resolveModelAuth(args({ isTTY: true, yes: true }))).toEqual([]);
  });

  it('still honours the flag and the config key with no TTY', async () => {
    expect(await resolveModelAuth(args({ isTTY: false, flag: 'codex' }))).toEqual(['codex']);
    expect(
      await resolveModelAuth(
        args({
          isTTY: false,
          settings: { modelAuth: 'codex' },
          sources: { 'openclaw.modelAuth': 'global' },
        }),
      ),
    ).toEqual(['codex']);
  });
});
