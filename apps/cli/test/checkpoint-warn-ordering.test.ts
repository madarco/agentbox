import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: the agent create body must warn about a checkpoint/agent
 * mismatch BEFORE its `-i` background early-return.
 *
 * `-i` writes a queue manifest and exits, so anything after that branch never
 * runs for a backgrounded create — the least supervised path there is, and the
 * one a configured default most easily hijacks. Bugbot caught exactly this on
 * `claude` after codex/opencode were already correct, which is why it is pinned
 * here rather than left to review.
 *
 * This was three assertions over three cloned command files. There is one body
 * now, so there is one place the ordering can regress.
 */
describe('checkpoint agent-mismatch warning ordering', () => {
  it('warns before the -i background early-return', () => {
    // __dirname-relative, not cwd-relative: vitest's cwd depends on where the
    // run was invoked from, and a cwd-relative read silently passes (or
    // ENOENTs) depending on that. Mirrors agent-create-image.test.ts.
    const src = readFileSync(
      join(__dirname, '..', 'src', 'agents', 'command', 'create-action.ts'),
      'utf8',
    );
    const warnAt = src.indexOf('warnCheckpointAgentMismatch(');
    const queueAt = src.indexOf('if (opts.initialPrompt && opts.initialPrompt.length > 0) {');
    expect(warnAt, 'create-action.ts must call warnCheckpointAgentMismatch').toBeGreaterThan(-1);
    expect(queueAt, 'create-action.ts must have an -i branch').toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(queueAt);
  });
});
