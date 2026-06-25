import { describe, expect, it } from 'vitest';

import { renderInnerCommand } from '../src/index.js';

// The TERM guard is shared with the docker provider (TERM_FALLBACK_SNIPPET).
// hetzner/daytona forward the host TERM over `ssh -t`, and vercel/e2b forward
// it via their attach builders, so the inner tmux command must downgrade an
// unrecognized TERM before tmux runs — otherwise `tmux attach` flash-quits.
const GUARD = 'infocmp "$TERM"';

describe('renderInnerCommand TERM guard', () => {
  it('prefixes the interactive attach with the TERM fallback guard', () => {
    const cmd = renderInnerCommand('shell');
    expect(cmd).toContain(GUARD);
    // guard runs before any tmux invocation
    expect(cmd.indexOf(GUARD)).toBeLessThan(cmd.indexOf('tmux'));
    expect(cmd).toMatch(/exec tmux attach -t/);
  });

  it('prefixes the agent attach with the guard too', () => {
    const cmd = renderInnerCommand('agent', { command: 'exec claude' });
    expect(cmd).toContain(GUARD);
    expect(cmd.indexOf(GUARD)).toBeLessThan(cmd.indexOf('tmux'));
  });

  it('guards the detached pre-start (no attach) as well', () => {
    const cmd = renderInnerCommand('agent', { command: 'exec claude', detached: true });
    expect(cmd).toContain(GUARD);
    // detached only creates/configures the session; it never attaches.
    expect(cmd).not.toContain('exec tmux attach');
  });

  it('does not inject the guard into the tmux-less paths (logs / noTmux)', () => {
    expect(renderInnerCommand('logs', { service: 'web' })).not.toContain(GUARD);
    expect(renderInnerCommand('shell', { noTmux: true })).not.toContain(GUARD);
  });
});
