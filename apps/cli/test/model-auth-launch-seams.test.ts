import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every place that STARTS an agent session must first run its model-auth
 * ingest.
 *
 * This is a source-level invariant because the failure is invisible at runtime:
 * the login is copied into the box either way, so a box that skipped the ingest
 * comes up looking healthy and is simply not authenticated. It has already
 * happened twice — the queued-job worker and `restoreAgentSessions` were both
 * hand-written copies of the "install, then start" sequence that predate the
 * ingest, and neither failed a test when they silently dropped it.
 *
 * The seams below are the docker ones. Cloud starts funnel through
 * `startDetachedCloudAgent`, which runs it internally, so a cloud caller cannot
 * get this wrong.
 */
const SEAMS = [
  // foreground `agentbox <agent>` create
  'src/agents/command/create-action.ts',
  // foreground `agentbox <agent> <box>` start / attach
  'src/agents/command/start-attach.ts',
  // the hub / tray / `-i` queue worker
  'src/commands/_run-queued-job.ts',
  // `agentbox start` / `unpause` / `recover`
  'src/agent-sessions.ts',
  // the dashboard, which launches agents itself rather than via agent-sessions
  'src/commands/dashboard.ts',
];

async function read(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

describe('model-auth ingest reaches every agent launch seam', () => {
  for (const rel of SEAMS) {
    it(`${rel} runs the ingest`, async () => {
      expect(await read(rel)).toContain('runModelAuthIngest');
    });
  }

  it('finds no OTHER module starting a docker agent session', async () => {
    // The list above is only as good as this: scan the tree for anything that
    // launches an agent session and fail if it is not accounted for. Without
    // this, the next hand-written copy of "install, then start" is silent in
    // exactly the same way the previous two were.
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    const offenders: string[] = [];
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.ts')) continue;
      const abs = join(f.parentPath, f.name);
      const rel = `src/${relative(root, abs)}`;
      if (SEAMS.includes(rel)) continue;
      const src = await readFile(abs, 'utf8');
      // `runtime.startSession(` is the docker launch; `startClaudeSession(` and
      // friends are the per-agent ones the queue worker calls directly.
      if (/\.startSession\(|\bstart(Claude|Codex|Opencode|Pi)Session\(/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      'these start an agent session but are not listed as a model-auth launch seam',
    ).toEqual([]);
  });
});
