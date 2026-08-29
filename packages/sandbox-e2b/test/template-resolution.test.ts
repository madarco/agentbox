import { describe, expect, it } from 'vitest';
import { resolveE2bTemplate } from '../src/backend.js';
import type { PreparedE2bState } from '../src/prepared-state.js';

const base = { templateId: 'tmpl_base:latest', createdAt: '2026-06-03T00:00:00Z' };
const claude = { templateId: 'tmpl_claude:latest', createdAt: '2026-06-04T00:00:00Z' };

/** Base + a claude variant, i.e. after `prepare` and `prepare --agents claude`. */
const withVariant: PreparedE2bState = {
  schema: 2,
  base,
  variants: { '': base, claude },
};

/** Base only, i.e. after the documented `agentbox prepare --provider e2b`. */
const baseOnly: PreparedE2bState = { schema: 2, base, variants: { '': base } };

describe('resolveE2bTemplate', () => {
  it('prefers the template built for exactly this agent set', () => {
    expect(resolveE2bTemplate(withVariant, { agents: ['claude'] })).toBe('tmpl_claude:latest');
  });

  it('falls back to the agentless base when the agent has no variant', () => {
    // The regression this guards: after a base-only prepare (the documented
    // install path) NO variant exists, and throwing here made every create
    // fail instead of booting the base and installing the agent at create.
    expect(resolveE2bTemplate(baseOnly, { agents: ['claude'] })).toBe('tmpl_base:latest');
    expect(resolveE2bTemplate(withVariant, { agents: ['codex'] })).toBe('tmpl_base:latest');
  });

  it('uses the base for an agentless create', () => {
    expect(resolveE2bTemplate(withVariant, {})).toBe('tmpl_base:latest');
    expect(resolveE2bTemplate(withVariant, { agents: [] })).toBe('tmpl_base:latest');
  });

  it('an explicit checkpoint snapshot always wins', () => {
    expect(
      resolveE2bTemplate(withVariant, { snapshot: 'tmpl_ckpt:latest', agents: ['claude'] }),
    ).toBe('tmpl_ckpt:latest');
  });

  it('is undefined only when nothing is prepared at all', () => {
    expect(resolveE2bTemplate({ schema: 2 }, { agents: ['claude'] })).toBeUndefined();
  });
});
