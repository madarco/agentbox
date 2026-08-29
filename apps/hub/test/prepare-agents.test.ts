import { describe, expect, it } from 'vitest';
import { parseProviderPrepare } from '../app/(dashboard)/api/v1/lib/validate.js';

describe('POST /providers/:id/prepare — agents', () => {
  it('accepts a valid agent set', () => {
    const r = parseProviderPrepare({ agents: ['claude', 'codex'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.agents).toEqual(['claude', 'codex']);
  });

  it('treats an absent or empty list as agentless', () => {
    for (const body of [{}, { agents: [] }]) {
      const r = parseProviderPrepare(body);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.agents).toBeUndefined();
    }
  });

  it('rejects an unknown agent rather than baking a base that lacks it', () => {
    const r = parseProviderPrepare({ agents: ['claude', 'gpt5'] });
    expect(r.ok).toBe(false);
  });

  it("rejects the create-time 'none' sentinel — an agentless base is an empty list", () => {
    const r = parseProviderPrepare({ agents: ['none'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(parseProviderPrepare({ agents: 'claude' }).ok).toBe(false);
  });
});
