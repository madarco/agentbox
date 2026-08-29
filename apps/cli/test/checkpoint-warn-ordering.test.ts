import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: every agent command must warn about a checkpoint/agent
 * mismatch BEFORE its `-i` background early-return.
 *
 * `-i` writes a queue manifest and exits, so anything after that branch never
 * runs for a backgrounded create — the least supervised path there is, and the
 * one a configured default most easily hijacks. Bugbot caught exactly this on
 * `claude` after codex/opencode were already correct, which is why it is pinned
 * here rather than left to review.
 */
const COMMANDS = ['claude', 'codex', 'opencode'] as const;

describe('checkpoint agent-mismatch warning ordering', () => {
  for (const cmd of COMMANDS) {
    it(`${cmd} warns before its -i background early-return`, () => {
      const src = readFileSync(join('src', 'commands', `${cmd}.ts`), 'utf8');
      const warnAt = src.indexOf('warnCheckpointAgentMismatch(');
      const queueAt = src.indexOf('if (opts.initialPrompt && opts.initialPrompt.length > 0) {');
      expect(warnAt, `${cmd}.ts must call warnCheckpointAgentMismatch`).toBeGreaterThan(-1);
      expect(queueAt, `${cmd}.ts must have an -i branch`).toBeGreaterThan(-1);
      expect(warnAt).toBeLessThan(queueAt);
    });
  }
});
