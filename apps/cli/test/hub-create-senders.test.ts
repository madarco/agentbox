import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]): string => readFileSync(join(here, '..', 'src', ...p), 'utf8');

/**
 * Every create that reaches a control box must build its options in ONE place.
 *
 * This is the failure the whole change exists to prevent: there used to be two
 * hand-written senders with nearly disjoint sets — one sent ten fields, the
 * other four — and a `size` fix that touched only one of them looked complete
 * for weeks. A grep is crude, but it is the only thing that fails when someone
 * writes a third literal.
 */
describe('one builder feeds every hub-routed create', () => {
  const senders = [
    ['commands', 'create.ts'],
    ['commands', '_cloud-agent-via-hub.ts'],
    ['agents', 'command', 'create-action.ts'],
    ['agents', 'command', 'service-action.ts'],
  ];

  it('each sender either builds the opts or forwards a built bag', () => {
    for (const parts of senders) {
      const s = src(...parts);
      const builds = s.includes('buildHubCreateOpts(');
      const forwards = s.includes('opts?: CreateJobRequestOpts');
      expect(builds || forwards, `${parts.join('/')} hand-rolls its hub opts`).toBe(true);
    }
  });

  it('no sender keeps a hand-written opts literal', () => {
    // The two names the old literals went by.
    for (const parts of senders) {
      const s = src(...parts);
      expect(s).not.toContain('const remoteOpts = {');
      expect(s).not.toContain('function hubCreateOpts(');
    }
  });

  it('the builder is the only thing that resolves sizing for the wire', () => {
    // `hubBoxShape` was the half-measure: size and location only. It is gone,
    // and nothing should reintroduce a partial resolver.
    for (const parts of senders) {
      expect(src(...parts)).not.toContain('hubBoxShape(');
    }
  });

  it('warnings reach the user rather than the log file alone', () => {
    // A providerWarning from the control box's worker used to be collected into
    // CommandLog.warnings() and never printed on either hub path.
    expect(src('commands', 'create.ts')).toContain('cmdLog.warnings()');
    expect(src('agents', 'command', 'create-action.ts')).toContain('cmdLog.warnings()');
  });
});

describe('a control-box create still does the host-side work', () => {
  it('validates and assigns --tasks instead of dropping them', () => {
    const s = src('commands', 'create.ts');
    const remoteAt = s.indexOf('async function runCreateViaHubApi(');
    expect(remoteAt).toBeGreaterThan(-1);
    // The remote function only; the local path has its own copy further down.
    const nextFn = s.indexOf('\nasync function ', remoteAt + 1);
    const remote = s.slice(remoteAt, nextFn > -1 ? nextFn : undefined);
    // `--tasks` was parsed and then the remote branch returned before the local
    // path's task handling: accepted flag, no effect, no warning.
    expect(remote).toContain('parseTaskIdsOrExit(opts.tasks)');
    expect(remote).toContain('preflightOrExit(');
    expect(remote).toContain('boxJobId: jobId');
  });

  it('keeps a --restore create on this machine', () => {
    // Its workspace is a staged bundle here; a control box would clone origin
    // and throw the restored tree away.
    expect(src('commands', 'create.ts')).toContain('forceLocal: opts.local || Boolean(restored)');
  });
});
