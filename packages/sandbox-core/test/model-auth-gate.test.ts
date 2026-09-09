import { describe, expect, it } from 'vitest';
import type { PromptRequest } from '@agentbox/core';
import { resolveAgentSpec } from '../src/index.js';
import {
  buildModelAuthPrompt,
  resolveModelAuth,
  type AvailableBorrow,
} from '../src/prompts/model-auth-gate.js';

/**
 * The host-boundary decision for a borrowed model login. Pure: the host-login
 * probe and the asker are injected, so nothing here touches ~/.agentbox.
 */
const openclaw = resolveAgentSpec('openclaw');
const codex = resolveAgentSpec('codex');
const none = { modelAuth: 'none' } as const;

const CODEX_BORROW: AvailableBorrow = {
  agent: 'codex',
  label: 'your Codex login (ChatGPT subscription OAuth)',
  hostPath: '/home/u/.codex/auth.json',
  boxPath: '/home/vscode/.codex/auth.json',
  bytes: 512,
};

function args(over: Partial<Parameters<typeof resolveModelAuth>[0]> = {}) {
  return {
    spec: openclaw,
    settings: none,
    configuredExplicitly: false,
    listAvailable: async () => [CODEX_BORROW],
    ask: () => {
      throw new Error('prompt must not be shown');
    },
    ...over,
  } as Parameters<typeof resolveModelAuth>[0];
}

/** An asker that always picks `value`, recording what it was shown. */
function picks(value: string, seen?: PromptRequest[]) {
  return async (req: PromptRequest) => {
    seen?.push(req);
    return { id: req.id, value };
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
        args({ settings: { modelAuth: 'codex' }, configuredExplicitly: true }),
      ),
    ).toEqual(['codex']);
  });

  it('an explicit `none` in config silences the prompt', async () => {
    expect(await resolveModelAuth(args({ configuredExplicitly: true }))).toEqual([]);
  });

  it('asks when nothing chose, and honours either answer', async () => {
    const seen: PromptRequest[] = [];
    expect(await resolveModelAuth(args({ ask: picks('none', seen) }))).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.topic).toBe('model-auth');
    expect(seen[0]!.kind).toBe('select');
    // Declining must be the pre-selected answer: copying a subscription login
    // into a daemon is never the calm default.
    expect(seen[0]!.defaultValue).toBe('none');
    expect(await resolveModelAuth(args({ ask: picks('codex') }))).toEqual(['codex']);
  });

  it('treats a dismissal as none', async () => {
    expect(
      await resolveModelAuth(
        args({ ask: async (req) => ({ id: req.id, value: 'codex', cancelled: true }) }),
      ),
    ).toEqual([]);
  });

  it('never asks when the host holds none of the declared logins', async () => {
    expect(await resolveModelAuth(args({ listAvailable: async () => [] }))).toEqual([]);
  });

  it('refuses an answer naming a borrow the row does not declare', async () => {
    await expect(resolveModelAuth(args({ ask: picks('claude') }))).rejects.toThrow(
      /declares codex/,
    );
  });
});

describe('buildModelAuthPrompt', () => {
  it('is a plain yes/no for the single-borrow case, with the credential detail', () => {
    const req = buildModelAuthPrompt('openclaw', [CODEX_BORROW]);
    // Yes carries the borrow; the card below already names which login it is,
    // so repeating it on the button would only overflow the row.
    expect(req.choices).toEqual([
      { value: 'codex', label: 'Yes' },
      { value: 'none', label: 'No' },
    ]);
    expect(req.detail).toMatchObject({
      type: 'credential',
      agent: 'codex',
      hostPath: '/home/u/.codex/auth.json',
      boxPath: '/home/vscode/.codex/auth.json',
    });
    // Declining is safe, so an asker that cannot reach a human takes it.
    expect(req.required).toBeUndefined();
    expect(req.fallback.value).toBe('none');
  });

  it('is content-addressed: the same offer is the same id, a different one is not', () => {
    const a = buildModelAuthPrompt('openclaw', [CODEX_BORROW]);
    const b = buildModelAuthPrompt('openclaw', [CODEX_BORROW]);
    const c = buildModelAuthPrompt('openclaw', [{ ...CODEX_BORROW, hostPath: '/elsewhere' }]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
});
