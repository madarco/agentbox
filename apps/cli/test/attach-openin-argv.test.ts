import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `openIn` re-entry argv must come off the registry.
 *
 * `runWrappedAttach` re-invokes `agentbox <agent> attach <box>` to open a NEW
 * pane for `attach.openIn: split|window|tab`. That builder used a hardcoded
 * `claude | codex | opencode | pi`, so for openclaw it returned null, the
 * spawn was skipped, and the attach silently downgraded to inline with nothing
 * said. Any agent with an `attach` subcommand belongs here.
 *
 * Source-asserted: the function is module-private and the surrounding call does
 * real terminal work, while the defect is precisely a literal list.
 */
const SRC = readFileSync(join(__dirname, '..', 'src', 'wrapped-pty', 'run.ts'), 'utf8');
const BODY = /function buildAgentboxAttachArgv\([\s\S]*?\n}/.exec(SRC)?.[0] ?? '';

describe('buildAgentboxAttachArgv', () => {
  it('does not enumerate the agents', () => {
    expect(BODY).not.toMatch(/'claude'/);
    expect(BODY).not.toMatch(/'codex'/);
    expect(BODY).not.toMatch(/'opencode'/);
  });

  it('resolves the agent through the registry', () => {
    expect(BODY).toMatch(/findAgentSpec/);
  });

  it('still returns null for a service agent with no client to attach to', () => {
    // `shell` and a repl-less service agent have no `attach` subcommand, so
    // re-invoking one would fail in the new pane.
    expect(BODY).toMatch(/isServiceAgent/);
    expect(BODY).toMatch(/repl/);
  });
});
