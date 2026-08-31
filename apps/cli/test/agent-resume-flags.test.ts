import { describe, expect, it, vi } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { resolveResumeSeed } from '../src/agents/command/create-action.js';
import { agentCommandEntry } from '../src/agents/commands.js';
import type { AgentCliSpec, AgentCreateContext } from '@agentbox/cli-kit';
import type { AgentCreateOptions } from '../src/agents/command/options.js';

/**
 * `-c` / `--resume` must be answered by EVERY agent, including one that has no
 * hooks of its own.
 *
 * This is a regression test with a scar. When session teleport lived in each
 * agent's own preflight hook, opencode — which has neither teleport nor a hook —
 * silently ignored `-c` and went on to build a box, instead of refusing the way
 * it always had. Nothing caught it: the flag is still declared, so the CLI
 * surface was unchanged, and no unit test drove the create body. It took a live
 * run (and a stray container) to notice.
 */

/** `ctx.fail` normally `process.exit`s; here it throws so we can assert on it. */
class Failed extends Error {}

/**
 * A host-services bag whose every member throws.
 *
 * These tests only exercise resume-flag parsing, which must not reach the setup
 * wizard, a re-bake or the clipboard. A stub that returned plausible values
 * would let such a call slip through silently; this one turns it into a failure
 * naming the member that was touched.
 */
function unreachableHost(): AgentCreateContext['host'] {
  const nope = (member: string) => (): never => {
    throw new Error(`host.${member} must not be reached by a resume-flag test`);
  };
  return {
    setupWizard: nope('setupWizard'),
    resolvePlanFile: nope('resolvePlanFile'),
    showInstallHint: nope('showInstallHint'),
    clipboard: {
      available: nope('clipboard.available'),
      pasteImage: nope('clipboard.pasteImage'),
      pasteImageFile: nope('clipboard.pasteImageFile'),
    },
  };
}

function fakeCtx(spec: AgentCliSpec, overrides: Partial<AgentCreateContext> = {}) {
  const fail = vi.fn((message: string) => {
    throw new Failed(message);
  });
  const ctx = {
    opts: {},
    workspace: '/tmp/nonexistent-workspace',
    cfg: {} as never,
    projectRoot: '/tmp/nonexistent-workspace',
    providerName: 'docker',
    writeLog: () => {},
    fail: fail as unknown as AgentCreateContext['fail'],
    routing: async () => ({ where: 'local' as const }),
    host: unreachableHost(),
    ...overrides,
  } satisfies AgentCreateContext;
  void spec;
  return { ctx, fail };
}

function specFor(id: string): AgentCliSpec {
  const entry = agentCommandEntry(id);
  expect(entry, `no command entry for '${id}'`).toBeDefined();
  // The descriptor isn't exported (the factory closes over it), so rebuild the
  // two fields `resolveResumeSeed` actually reads.
  return {
    id,
    spec: resolveAgentSpec(id),
    text: {
      resumeWithPromptError: `${id}: -i and -c conflict`,
      hubIncompatibleReason: `${id}: via-hub ignored`,
    },
  } as unknown as AgentCliSpec;
}

const opts = (o: Partial<AgentCreateOptions>): AgentCreateOptions =>
  ({ workspace: '/tmp/nonexistent-workspace', ...o }) as AgentCreateOptions;

describe('-c / --resume is answered for every agent', () => {
  it('an agent with no teleport refuses instead of building a box', async () => {
    const stub = [...['claude', 'codex', 'opencode']].filter(
      (id) => resolveAgentSpec(id).caps.teleport === 'stub',
    );
    expect(stub.length, 'expected at least one stub-teleport agent to cover').toBeGreaterThan(0);
    for (const id of stub) {
      const { ctx, fail } = fakeCtx(specFor(id));
      await expect(
        resolveResumeSeed(specFor(id), ctx, opts({ continue: true })),
      ).rejects.toBeInstanceOf(Failed);
      // The reason comes from the registry row, not from this call site.
      expect(fail.mock.calls[0]?.[0]).toBe(resolveAgentSpec(id).caps.teleportStubReason);
    }
  });

  it('no resume flag means no seed and no refusal', async () => {
    for (const id of ['claude', 'codex', 'opencode']) {
      const { ctx, fail } = fakeCtx(specFor(id));
      await expect(resolveResumeSeed(specFor(id), ctx, opts({}))).resolves.toEqual({ seeds: [] });
      expect(fail).not.toHaveBeenCalled();
    }
  });

  it('-c and --resume together are refused', async () => {
    const { ctx, fail } = fakeCtx(specFor('codex'));
    await expect(
      resolveResumeSeed(specFor('codex'), ctx, opts({ continue: true, resume: 'abc' })),
    ).rejects.toBeInstanceOf(Failed);
    expect(fail.mock.calls[0]?.[0]).toMatch(/only one of/);
  });

  it('-i alongside -c is refused with the agent’s own wording', async () => {
    const { ctx, fail } = fakeCtx(specFor('codex'));
    await expect(
      resolveResumeSeed(specFor('codex'), ctx, opts({ continue: true, initialPrompt: 'hi' })),
    ).rejects.toBeInstanceOf(Failed);
    expect(fail.mock.calls[0]?.[0]).toBe('codex: -i and -c conflict');
  });
});
