import { describe, expect, it } from 'vitest';
import { normalizeLastAgent } from '@agentbox/core';
import { findAgentSpec } from '@agentbox/sandbox-core';

/**
 * The Box payload's `agent` must name the agent the box is actually for.
 *
 * The bug: `mapBox` read it as `normalizeLastAgent(b.lastAgent) ?? 'claude'`.
 * That helper validates against `BUILTIN_AGENT_KINDS`, the four agents compiled
 * into the dependency-free `@agentbox/core`, which has no registry to ask — so
 * it answered `undefined` for openclaw and the fallback reported an OpenClaw box
 * as a **Claude** box. Every client keys off this field: the tray drew the
 * Claude mark and offered Claude actions on a box with no tmux session at all.
 *
 * This pins the RULE (registry first, helper second), not `mapBox` itself, which
 * needs a whole ListedBox to call.
 */
const resolve = (raw: string | undefined): string =>
  (raw ? findAgentSpec(raw)?.id : undefined) ?? normalizeLastAgent(raw) ?? 'claude';

describe('Box payload agent resolution', () => {
  it('keeps a service agent instead of falling back to claude', () => {
    expect(normalizeLastAgent('openclaw')).toBeUndefined(); // the trap
    expect(resolve('openclaw')).toBe('openclaw');
  });

  it('still normalizes the frozen wire spelling', () => {
    expect(resolve('claude-code')).toBe('claude');
  });

  it('keeps every built-in id unchanged', () => {
    for (const id of ['claude', 'codex', 'opencode', 'pi']) expect(resolve(id)).toBe(id);
  });

  it('falls back to claude for a box with no agent', () => {
    // Pre-existing behaviour: the field is non-optional on the payload.
    expect(resolve(undefined)).toBe('claude');
  });

  it('falls back for an id no build knows, rather than throwing', () => {
    expect(resolve('not-an-agent')).toBe('claude');
  });
});
