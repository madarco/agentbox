import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HISTORY_BINDINGS_FILE } from '@agentbox/core';

// The pre-commit cleanup is what keeps per-box state out of a checkpoint image.
// The history binding log is per-box (it says which sessions THIS box ran); a
// checkpoint that carried it would make every box made from it ship the source
// box's sessions. Shippers also filter by box id; this is the backstop.
describe('agentbox-checkpoint-cleanup', () => {
  const script = readFileSync(
    new URL('../scripts/agentbox-checkpoint-cleanup', import.meta.url),
    'utf8',
  );

  it('deletes the session-history binding log', () => {
    expect(script).toContain(`rm -f /home/vscode/${HISTORY_BINDINGS_FILE}`);
  });
});
