import { describe, expect, it, vi } from 'vitest';
import { writeWakeAgentEnv } from '../src/cloud-provider.js';

describe('writeWakeAgentEnv', () => {
  it('retries once', async () => {
    let n = 0;
    await writeWakeAgentEnv(
      'b',
      () => (++n === 1 ? Promise.reject(new Error('x')) : Promise.resolve()),
      true,
    );
    expect(n).toBe(2);
  });

  it("fails the wake when the file holds a pasted account's token", async () => {
    await expect(
      writeWakeAgentEnv('b', () => Promise.reject(new Error('exit 1')), true),
    ).rejects.toThrow(/account token.*exit 1/);
  });

  it('only warns when it holds forwarded keys alone', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeWakeAgentEnv('b', () => Promise.reject(new Error('exit 1')), false);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/WARN: b: agent env not rewritten/);
    spy.mockRestore();
  });
});
