import { describe, expect, it, vi } from 'vitest';
import { promptForCarry } from '../src/carry-prompt.js';
import type { ResolvedCarryEntry } from '../src/lib/carry-resolve.js';

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: (v: unknown) => v === SYMBOL_CANCEL,
  log: { message: vi.fn() },
  select: vi.fn(),
}));

const SYMBOL_CANCEL = Symbol('cancel');

const { select } = (await import('@clack/prompts')) as unknown as {
  select: ReturnType<typeof vi.fn>;
};

function entry(over: Partial<ResolvedCarryEntry> = {}): ResolvedCarryEntry {
  return {
    rawSrc: '~/.agentbox/secrets.env',
    rawDest: '~/.agentbox/secrets.env',
    absSrc: '/home/marco/.agentbox/secrets.env',
    absDest: '~/.agentbox/secrets.env',
    kind: 'file',
    bytes: 100,
    optional: false,
    ...over,
  };
}

describe('promptForCarry', () => {
  it('empty entries → approve immediately, no prompt', async () => {
    const result = await promptForCarry({ resolved: [] });
    expect(result).toBe('approve');
    expect(select).not.toHaveBeenCalled();
  });

  it('--carry-yes skips the prompt and approves', async () => {
    const result = await promptForCarry({ resolved: [entry()], carryYes: true });
    expect(result).toBe('approve');
    expect(select).not.toHaveBeenCalled();
  });

  it('--carry=skip skips the prompt and returns skip-this-run', async () => {
    const result = await promptForCarry({ resolved: [entry()], carrySkip: true });
    expect(result).toBe('skip-this-run');
    expect(select).not.toHaveBeenCalled();
  });

  it('-y + non-TTY + non-empty entries throws fail-loud', async () => {
    await expect(promptForCarry({ resolved: [entry()], yes: true, isTTY: false })).rejects.toThrow(
      /AGENTBOX_CARRY_YES=1/,
    );
  });

  it('non-TTY without any opt-in also throws (carry never silently runs in CI)', async () => {
    await expect(promptForCarry({ resolved: [entry()], isTTY: false })).rejects.toThrow(
      /AGENTBOX_CARRY_YES=1/,
    );
  });

  it('-y on a TTY still falls through to the prompt', async () => {
    select.mockResolvedValueOnce('approve');
    const result = await promptForCarry({ resolved: [entry()], yes: true, isTTY: true });
    expect(result).toBe('approve');
    expect(select).toHaveBeenCalledOnce();
  });

  it('on TTY, returns the user’s selection (approve / skip / cancel)', async () => {
    select.mockResolvedValueOnce('skip-this-run');
    expect(await promptForCarry({ resolved: [entry()], isTTY: true })).toBe('skip-this-run');

    select.mockResolvedValueOnce('cancel');
    expect(await promptForCarry({ resolved: [entry()], isTTY: true })).toBe('cancel');
  });

  // The default owner is "the box user", resolved in-box — so an explicit
  // `user:` is always an override the human should see before approving,
  // including `user: 1000`, which now pins a literal uid rather than
  // restating the default (vscode is not 1000 on vercel/e2b).
  it('shows a user flag whenever user: is set explicitly, and none when unset', async () => {
    const { log } = (await import('@clack/prompts')) as unknown as {
      log: { message: ReturnType<typeof vi.fn> };
    };

    async function render(over: Partial<ResolvedCarryEntry>): Promise<string> {
      log.message.mockClear();
      select.mockResolvedValueOnce('approve');
      await promptForCarry({ resolved: [entry(over)], isTTY: true });
      return log.message.mock.calls.map((c) => String(c[0])).join('\n');
    }

    expect(await render({ user: 1000 })).toContain('user 1000');
    expect(await render({ user: 0 })).toContain('user 0');
    expect(await render({})).not.toContain('user ');
  });

  it('Ctrl-C (isCancel) hard-exits with code 130', async () => {
    select.mockResolvedValueOnce(SYMBOL_CANCEL);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit:${String(code)}`);
      });
    try {
      await expect(promptForCarry({ resolved: [entry()], isTTY: true })).rejects.toThrow(
        'exit:130',
      );
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
