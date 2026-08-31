import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guards on daemon startup ordering.
 *
 * `agents.list` is an RPC through the in-box relay on :8788. Fetched before the
 * forwarder binds it is a guaranteed ECONNREFUSED on a fresh box — and because
 * the fallback to the baked watch list is SILENT BY DESIGN, that failure is
 * invisible: the box quietly keeps its compiled-in list forever, so a post-bake
 * or plugin-supplied agent is never watched at all and nothing anywhere errors.
 *
 * The daemon already had this exact rule for `toolLinks.start()` with the
 * reason in a comment; the fetch was added above it anyway. Hence a test rather
 * than another comment.
 */
describe('daemon startup order', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'daemon.ts'), 'utf8');

  it('fetches the watch list AFTER the relay forwarder is listening', () => {
    const forwarderAt = src.indexOf('toolLinks.start()');
    const fetchAt = src.indexOf('fetchWatchList(');
    expect(forwarderAt, 'toolLinks.start() marks the post-forwarder point').toBeGreaterThan(-1);
    expect(fetchAt, 'daemon must fetch the watch list').toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(forwarderAt);
  });

  it('starts the credentials watcher BEFORE the fetch, on the baked list', () => {
    // The fetch must never gate the watcher. On a cloud box `agents.list` parks
    // on a HostActionQueue that has no timeout and only expires on a host drain,
    // so with the host off it never settles: awaiting it cost the box credential
    // fan-out outright. Start baked, upgrade later via setFiles().
    const startAt = src.indexOf('credentialsWatcher = new CredentialsWatcher(');
    const fetchAt = src.indexOf('fetchWatchList(');
    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(fetchAt);
  });

  it('does not await the fetch on the critical path', () => {
    // `await fetchWatchList()` anywhere here also delays the SIGTERM/SIGINT
    // handlers registered below it, so a stop during the hang skips the whole
    // graceful path (credential flush, stopAll, relay close).
    expect(src).not.toMatch(/await\s+fetchWatchList\(/);
    expect(src).toMatch(/void\s+fetchWatchList\(/);
  });

  it('fetches the watch list OUTSIDE the credential-sync gate', () => {
    // The fetch serves two consumers — the credential watcher and the agent
    // PROBE list — and only one of them is about credentials. It used to sit
    // inside `if (AGENTBOX_CREDENTIAL_SYNC !== '0')`, so a box created with
    // `--no-credential-sync` also never upgraded which agents it probes: a
    // fourth agent's tmux session was invisible in `agentbox list` on that box.
    //
    // Source-level, like the ordering checks above: the failure is silent (the
    // reporter just keeps its baked list), so nothing observable breaks.
    const gateAt = src.indexOf("AGENTBOX_CREDENTIAL_SYNC !== '0'");
    const fetchAt = src.indexOf('fetchWatchList(');
    expect(gateAt, 'the credential-sync gate must still exist').toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(gateAt);

    // The gate's block must CLOSE before the fetch — i.e. the fetch is not
    // nested inside it. Counting braces between the two is enough: a fetch
    // still inside the block never returns to depth 0.
    const between = src.slice(gateAt, fetchAt);
    let depth = 0;
    for (const ch of between) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    expect(depth, 'fetchWatchList must not be nested inside the gate').toBe(0);
  });
});
