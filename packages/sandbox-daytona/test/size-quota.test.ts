import { describe, expect, it } from 'vitest';
import { isResourceLimitError, sizeOverQuotaMessage } from '../src/backend.js';

/**
 * Daytona caps resources per sandbox on the account, and the SDK reports the
 * refusal as a `DaytonaValidationError` inside an axios stack — the one line
 * that matters used to scroll away under twenty lines of frames.
 */
describe('isResourceLimitError', () => {
  it('matches the refusal a too-large bake actually fails with', () => {
    const err = new Error(
      'Disk request 20GB exceeds maximum allowed per sandbox (10GB).\n' +
        'Need higher resource limits per-sandbox? Contact us at support@daytona.io',
    );
    expect(isResourceLimitError(err)).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isResourceLimitError(new Error('Region us-east-1 not found'))).toBe(false);
    expect(isResourceLimitError(new Error('build snapshot: rpc error'))).toBe(false);
  });
});

describe('sizeOverQuotaMessage', () => {
  const err = new Error(
    'Disk request 20GB exceeds maximum allowed per sandbox (10GB).\nContact support@daytona.io',
  );
  const msg = sizeOverQuotaMessage({ cpu: 4, memory: 8, disk: 20 }, err);

  it('names the size that was refused', () => {
    expect(msg).toContain('4-8-20');
  });

  // The cap Daytona reports is the only place the real number appears, so it
  // must survive into the message rather than being replaced by a guess.
  it('quotes the cap Daytona reported', () => {
    expect(msg).toContain('exceeds maximum allowed per sandbox (10GB)');
  });

  it('says the ceiling is the plan, not AgentBox, and how to move it', () => {
    expect(msg).toContain('not by AgentBox');
    expect(msg).toContain('support@daytona.io');
    expect(msg).toContain('agentbox prepare --provider daytona --size');
  });

  // A multi-line SDK message would drag the axios noise back into the summary.
  it('keeps only the first line of the SDK error', () => {
    expect(msg).not.toContain('Contact support@daytona.io');
  });
});
