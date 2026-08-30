import { describe, expect, it } from 'vitest';
import { parseAgentDescriptors } from '../src/agent-registry.js';

/**
 * ctl is baked into the box image, so its compiled-in watch list is frozen at
 * bake time. These cover the parse half of pulling it from the host instead —
 * and above all the cases where the answer must be REFUSED so the caller keeps
 * the baked list. Watching nothing would silently break credential fan-out for
 * the whole fleet, which is far worse than watching a slightly stale list.
 */
describe('parseAgentDescriptors', () => {
  const good = JSON.stringify({
    schema: 1,
    agents: [
      {
        id: 'claude',
        watch: [
          { path: '/home/vscode/.claude/.credentials.json', sync: 'fanout', shape: 'claude-oauth' },
        ],
      },
    ],
  });

  it('parses a well-formed payload', () => {
    expect(parseAgentDescriptors(good)).toEqual([
      { agent: 'claude', path: '/home/vscode/.claude/.credentials.json', shape: 'claude-oauth' },
    ]);
  });

  it('ignores unknown fields so a NEWER host cannot break an older box', () => {
    const withExtras = JSON.stringify({
      schema: 99,
      somethingFromTheFuture: { nested: true },
      agents: [
        {
          id: 'claude',
          tomorrowsField: 42,
          watch: [
            {
              path: '/home/vscode/.claude/.credentials.json',
              sync: 'fanout',
              shape: 'claude-oauth',
              futureKnob: 'x',
            },
          ],
        },
      ],
    });
    expect(parseAgentDescriptors(withExtras)).toHaveLength(1);
  });

  it('refuses malformed JSON, non-objects and a missing agents array', () => {
    // null means "keep the baked list", never "watch nothing".
    expect(parseAgentDescriptors('not json')).toBeNull();
    expect(parseAgentDescriptors('"a string"')).toBeNull();
    expect(parseAgentDescriptors('null')).toBeNull();
    expect(parseAgentDescriptors(JSON.stringify({ schema: 1 }))).toBeNull();
  });

  it('refuses an EMPTY list rather than watching nothing', () => {
    // A host that answers `{agents: []}` is malformed, not authoritative. Taking
    // it literally would stop the credential watcher dead and kill login
    // fan-out across the fleet with no error anywhere.
    expect(parseAgentDescriptors(JSON.stringify({ schema: 1, agents: [] }))).toBeNull();
  });

  it('drops a fanout watch with no validatable shape', () => {
    // Only `fanout` posts a blob to the relay, and only a known shape can be
    // validated before posting. An unvalidatable one is dropped, not posted.
    const bad = JSON.stringify({
      schema: 1,
      agents: [{ id: 'x', watch: [{ path: '/tmp/a', sync: 'fanout' }] }],
    });
    expect(parseAgentDescriptors(bad)).toBeNull();
  });

  it('does not treat a backup watch as a credential', () => {
    // `backup` watches route through cp.toHost, not the credential event — they
    // must never reach the credential watcher's post path.
    const mixed = JSON.stringify({
      schema: 1,
      agents: [
        {
          id: 'claude',
          watch: [
            {
              path: '/home/vscode/.claude/.credentials.json',
              sync: 'fanout',
              shape: 'claude-oauth',
            },
            { path: '/home/vscode/.claude/projects', sync: 'backup', hostDest: 'logs' },
          ],
        },
      ],
    });
    const got = parseAgentDescriptors(mixed);
    expect(got).toHaveLength(1);
    expect(got?.[0]?.path).toBe('/home/vscode/.claude/.credentials.json');
  });

  it('skips entries with no id or no path instead of failing the whole payload', () => {
    const partial = JSON.stringify({
      schema: 1,
      agents: [
        { watch: [{ path: '/tmp/x', sync: 'fanout', shape: 'nonempty-json' }] },
        { id: 'codex', watch: [{ sync: 'fanout', shape: 'nonempty-json' }] },
        { id: 'codex', watch: [{ path: '/tmp/ok', sync: 'fanout', shape: 'nonempty-json' }] },
      ],
    });
    expect(parseAgentDescriptors(partial)).toEqual([
      { agent: 'codex', path: '/tmp/ok', shape: 'nonempty-json' },
    ]);
  });
});
