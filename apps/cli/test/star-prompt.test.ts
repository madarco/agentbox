import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate HOME: the module reads `homedir()` to locate ~/.agentbox/star-prompt.json.
let HOME = '';
vi.mock('node:os', async (orig) => {
  const real = (await orig()) as typeof import('node:os');
  return { ...real, homedir: () => HOME };
});

// Mock the prompt surface so confirm() is scriptable and log is silent.
vi.mock('../src/lib/prompt.js', () => ({
  confirm: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@agentbox/sandbox-core', () => ({ hostOpenCommand: () => 'open' }));

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const { maybePromptStar } = await import('../src/lib/star-prompt.js');
const { confirm } = (await import('../src/lib/prompt.js')) as unknown as {
  confirm: ReturnType<typeof vi.fn>;
};
const { spawnSync } = (await import('node:child_process')) as unknown as {
  spawnSync: ReturnType<typeof vi.fn>;
};

const STATE = (): string => join(HOME, '.agentbox', 'star-prompt.json');
function readState(): { installCount: number; starred: boolean; answered: boolean } | null {
  return existsSync(STATE())
    ? (JSON.parse(readFileSync(STATE(), 'utf8')) as {
        installCount: number;
        starred: boolean;
        answered: boolean;
      })
    : null;
}
function seedState(installCount: number, starred = false, answered = false): void {
  mkdirSync(join(HOME, '.agentbox'), { recursive: true });
  writeFileSync(STATE(), JSON.stringify({ version: 1, installCount, starred, answered }));
}

let prevTTY: boolean | undefined;
beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'agentbox-star-'));
  vi.clearAllMocks();
  prevTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  // gh ready + every gh call succeeds by default; individual tests override.
  spawnSync.mockReturnValue({ status: 0, error: undefined });
});
afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
});

describe('maybePromptStar — install cadence', () => {
  it('does not prompt on installs 1 and 2, but counts them', async () => {
    await maybePromptStar({ trigger: 'install' });
    await maybePromptStar({ trigger: 'install' });
    expect(confirm).not.toHaveBeenCalled();
    expect(readState()?.installCount).toBe(2);
  });

  it('prompts on the 3rd install, then the recorded answer suppresses the 4th window', async () => {
    seedState(2);
    await maybePromptStar({ trigger: 'install' }); // -> 3, prompts and records the answer
    expect(confirm).toHaveBeenCalledTimes(1);
    await maybePromptStar({ trigger: 'install' }); // -> answered, no prompt (count frozen)
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readState()?.installCount).toBe(3);
  });

  it('re-asks on the 4th install only if the 3rd never got an answer recorded', async () => {
    seedState(3); // 3rd window passed without an answer (e.g. process died mid-prompt)
    await maybePromptStar({ trigger: 'install' }); // -> 4
    expect(confirm).toHaveBeenCalledTimes(1);
    seedState(4);
    await maybePromptStar({ trigger: 'install' }); // -> 5, past the window
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readState()?.installCount).toBe(5);
  });
});

describe('maybePromptStar — guards', () => {
  it('never prompts when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    seedState(2);
    await maybePromptStar({ trigger: 'install' });
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never prompts once starred', async () => {
    seedState(2, true);
    await maybePromptStar({ trigger: 'install' });
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never prompts once answered, even unstarred', async () => {
    seedState(2, false, true);
    await maybePromptStar({ trigger: 'install' });
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('maybePromptStar — self-update', () => {
  it('prompts regardless of install count until answered', async () => {
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('maybePromptStar — star action', () => {
  it('answering no records the answer and never asks again', async () => {
    confirm.mockResolvedValue(false);
    await maybePromptStar({ trigger: 'self-update' });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readState()?.starred).toBeFalsy();
    expect(readState()?.answered).toBe(true);
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('gh ready → stars via gh api and records starred=true', async () => {
    confirm.mockResolvedValue(true);
    await maybePromptStar({ trigger: 'self-update' });
    const calls = spawnSync.mock.calls.map((c) => c[0]);
    expect(calls).toContain('gh');
    const putCall = spawnSync.mock.calls.find(
      (c) => c[0] === 'gh' && Array.isArray(c[1]) && c[1].includes('PUT'),
    );
    expect(putCall?.[1]).toEqual(['api', '--method', 'PUT', '/user/starred/madarco/agentbox']);
    expect(readState()?.starred).toBe(true);
  });

  it('gh not authenticated → falls back to opening the browser, starred stays false', async () => {
    confirm.mockResolvedValue(true);
    // gh auth status fails; browser open succeeds.
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'auth') return { status: 1, error: undefined };
      return { status: 0, error: undefined };
    });
    await maybePromptStar({ trigger: 'self-update' });
    const openCall = spawnSync.mock.calls.find((c) => c[0] === 'open');
    expect(openCall?.[1]).toEqual(['https://github.com/madarco/agentbox']);
    // gh api PUT must NOT have run.
    expect(
      spawnSync.mock.calls.some((c) => Array.isArray(c[1]) && c[1].includes('PUT')),
    ).toBe(false);
    expect(readState()?.starred).toBeFalsy();
    // The answer is still recorded — the browser path must not re-ask forever.
    expect(readState()?.answered).toBe(true);
    await maybePromptStar({ trigger: 'self-update' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('gh missing (ENOENT) → falls back to the browser', async () => {
    confirm.mockResolvedValue(true);
    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') return { status: null, error: new Error('spawn gh ENOENT') };
      return { status: 0, error: undefined };
    });
    await maybePromptStar({ trigger: 'self-update' });
    expect(spawnSync.mock.calls.some((c) => c[0] === 'open')).toBe(true);
    expect(readState()?.starred).toBeFalsy();
  });
});
