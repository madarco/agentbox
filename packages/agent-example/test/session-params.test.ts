import { describe, expect, it } from 'vitest';
import { buildExampleAttachArgv, exampleSessionInfo } from '../src/docker-sync.js';
import { exampleRuntime } from '../src/cli/runtime.js';

/**
 * The demo agent is the TEMPLATE a new agent copies, so an adapter that quietly
 * drops a parameter teaches every future agent to drop it. `--session-name` and
 * `agentbox example -- <args>` both have to reach tmux.
 *
 * This was real: the first version called `startExampleSession(o.container)`
 * and ignored both, so `--session-name` silently targeted the spec default.
 */
describe('the example runtime forwards what it is given', () => {
  it('targets the requested session when attaching, not the spec default', () => {
    const argv = buildExampleAttachArgv('box1', 'mine').join(' ');
    expect(argv).toContain('mine');
    expect(argv).not.toContain('"example"');
  });

  it('falls back to the spec default when no session name is given', () => {
    expect(buildExampleAttachArgv('box1').join(' ')).toContain('example');
  });

  it('passes the session name through sessionInfo', async () => {
    // Through the package's own function, not the runtime adapter: the
    // CONTRACT's `sessionInfo` return type is narrowed to `{ running }`, so a
    // dropped session name would be invisible through that door.
    const info = await exampleSessionInfo('no-such-container', 'mine');
    expect(info.sessionName).toBe('mine');
    expect(info.running).toBe(false);

    // And the adapter forwards it — same call, through the runtime.
    const viaRuntime = await exampleRuntime.sessionInfo('no-such-container', 'mine');
    expect((viaRuntime as unknown as { sessionName: string }).sessionName).toBe('mine');
  }, 20_000);
});
