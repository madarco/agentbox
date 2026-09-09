import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { resolveModelAuth } from '../src/lib/model-auth-gate.js';

/**
 * The host-boundary decision for a borrowed model login. Pure: the host-login
 * probe and the prompt are injected, so nothing here touches ~/.agentbox.
 */
const openclaw = resolveAgentSpec('openclaw');
const codex = resolveAgentSpec('codex');
const none = { modelAuth: 'none' } as const;

function args(over: Partial<Parameters<typeof resolveModelAuth>[0]> = {}) {
  return {
    spec: openclaw,
    settings: none,
    sources: {},
    hostHasLogin: async () => true,
    ask: async () => {
      throw new Error('prompt must not be shown');
    },
    ...over,
  };
}

describe('resolveModelAuth', () => {
  it('--model-auth wins outright, and none means none', async () => {
    expect(await resolveModelAuth(args({ flag: 'codex' }))).toEqual(['codex']);
    expect(await resolveModelAuth(args({ flag: 'none' }))).toEqual([]);
  });

  it('refuses a flag value the row does not declare', async () => {
    await expect(resolveModelAuth(args({ flag: 'claude' }))).rejects.toThrow(/declares codex/);
  });

  it('refuses the flag on an agent that borrows nothing', async () => {
    await expect(resolveModelAuth(args({ spec: codex, flag: 'codex' }))).rejects.toThrow(
      /borrows no host login/,
    );
    expect(await resolveModelAuth(args({ spec: codex }))).toEqual([]);
  });

  it('reads the config key when the user set it', async () => {
    expect(
      await resolveModelAuth(
        args({ settings: { modelAuth: 'codex' }, sources: { 'openclaw.modelAuth': 'global' } }),
      ),
    ).toEqual(['codex']);
  });

  it('an explicit `none` in config silences the prompt', async () => {
    expect(await resolveModelAuth(args({ sources: { 'openclaw.modelAuth': 'project' } }))).toEqual(
      [],
    );
  });

  it('with nothing chosen: asks on a TTY when the host holds the login, defaulting to no', async () => {
    const asked: string[] = [];
    expect(
      await resolveModelAuth(
        args({
          isTTY: true,
          ask: async (m) => {
            asked.push(m);
            return false;
          },
        }),
      ),
    ).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/--model-auth codex/);
    expect(asked[0]).toMatch(/config set openclaw\.modelAuth codex/);
    expect(await resolveModelAuth(args({ isTTY: true, ask: async () => true }))).toEqual(['codex']);
  });

  it('never asks without a TTY, under --yes, or when the host has no such login', async () => {
    expect(await resolveModelAuth(args({ isTTY: false }))).toEqual([]);
    expect(await resolveModelAuth(args({ isTTY: true, yes: true }))).toEqual([]);
    expect(await resolveModelAuth(args({ isTTY: true, hostHasLogin: async () => false }))).toEqual(
      [],
    );
  });
});
