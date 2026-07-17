import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing anything that resolves ~/.agentbox — the hub
// listing cache lives there and apps/cli tests share the real home otherwise.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-hub-list-home-'));
process.env['HOME'] = TEST_HOME;

const { cacheAge, hubBoxesCachePath } = await import('../src/control-plane/hub-list.js');

afterEach(async () => {
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe('hubBoxesCachePath', () => {
  it('lives under the agentbox state dir', () => {
    expect(hubBoxesCachePath()).toBe(join(homedir(), '.agentbox', 'hub-boxes-cache.json'));
  });
});

describe('cacheAge', () => {
  const base = Date.parse('2026-07-17T12:00:00.000Z');
  const at = (ms: number) => cacheAge(new Date(base - ms).toISOString(), base);

  it('renders a human age for the staleness note', () => {
    expect(at(5_000)).toBe('just now');
    expect(at(3 * 60_000)).toBe('3m ago');
    expect(at(2 * 3_600_000)).toBe('2h ago');
    expect(at(3 * 86_400_000)).toBe('3d ago');
  });

  it('never renders a negative age from a clock skew', () => {
    expect(cacheAge(new Date(base + 60_000).toISOString(), base)).toBe('just now');
  });
});
