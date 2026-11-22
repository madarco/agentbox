import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `agentbox <agent> --provider docker:<host> -i` queues a job whose
 * `providerName` is the bare `remote-docker`; the engine host only survives if
 * the job's createOpts carry it. Without it the worker failed in half a second
 * with "remote-docker needs an SSH destination" (found by the release e2e run).
 */
describe('the -i local queue job carries the remote-docker host', () => {
  it('submitQueueJob createOpts include remoteHost', () => {
    const s = readFileSync(
      join(__dirname, '..', 'src', 'agents', 'command', 'create-action.ts'),
      'utf8',
    );
    const start = s.indexOf('submitQueueJob({');
    expect(start).toBeGreaterThan(-1);
    const call = s.slice(start, s.indexOf('maxRunningOverride,', start));
    expect(call).toContain('...(remoteHost ? { remoteHost } : {})');
  });
});
