import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmSpy = vi.hoisted(() => vi.fn<(opts: { message: string }) => Promise<boolean>>());
vi.mock('@agentbox/cli-kit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  confirm: confirmSpy,
}));

import { maybeRunSetupWizard } from '../src/wizard.js';

describe('stale cloud base prompt', () => {
  let wasTTY: boolean | undefined;
  beforeEach(() => {
    wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    confirmSpy.mockReset();
    confirmSpy.mockResolvedValue(false);
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  });

  it('says why the base is stale, since Yes also starts without the default checkpoint', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'wizard-stale-'));
    await maybeRunSetupWizard({
      workspace,
      yes: false,
      command: 'create',
      provider: 'hetzner',
      baseStatus: { state: 'stale', reason: 'host skills changed since this base was baked' },
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0]![0].message;
    expect(message).toContain('out of date (host skills changed since this base was baked)');
    expect(message).toContain('without the default checkpoint');
  });
});
