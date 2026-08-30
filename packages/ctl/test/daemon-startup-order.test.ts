import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard on daemon startup ordering.
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

  it('starts the credentials watcher after that fetch, not before', () => {
    // Starting it earlier with the baked list would work, but then the pulled
    // list would never reach it — the watcher reads `files` once, at construction.
    const fetchAt = src.indexOf('fetchWatchList(');
    const startAt = src.indexOf('credentialsWatcher = new CredentialsWatcher(');
    expect(startAt).toBeGreaterThan(fetchAt);
  });
});
