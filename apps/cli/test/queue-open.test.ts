import { describe, expect, it } from 'vitest';
import { captureOpenTerminalContext } from '../src/terminal/queue-open.js';

const CWD = '/Users/x/proj';

describe('captureOpenTerminalContext', () => {
  it('returns undefined when the mode is "none" (default — open nothing)', () => {
    expect(
      captureOpenTerminalContext('none', { TMUX: '/tmp/tmux-501/default,1,0' }, CWD),
    ).toBeUndefined();
  });

  it('returns undefined when the host terminal is unknown', () => {
    expect(
      captureOpenTerminalContext('split', { TERM_PROGRAM: 'Apple_Terminal' }, CWD),
    ).toBeUndefined();
  });

  it('captures the tmux socket + pane for a tmux host', () => {
    expect(
      captureOpenTerminalContext(
        'split',
        { TMUX: '/private/tmp/tmux-501/default,12345,0', TMUX_PANE: '%5' },
        CWD,
      ),
    ).toEqual({
      host: 'tmux',
      mode: 'split',
      cwd: CWD,
      tmuxSocket: '/private/tmp/tmux-501/default,12345,0',
      tmuxPane: '%5',
    });
  });

  it('captures the cmux socket + bundled CLI for a cmux host', () => {
    expect(
      captureOpenTerminalContext(
        'window',
        {
          CMUX_SOCKET_PATH: '/Users/x/Library/Application Support/cmux/cmux.sock',
          CMUX_BUNDLED_CLI_PATH: '/Applications/cmux.app/Contents/Resources/cmux',
          TERM_PROGRAM: 'ghostty',
        },
        CWD,
      ),
    ).toEqual({
      host: 'cmux',
      mode: 'window',
      cwd: CWD,
      cmuxSocket: '/Users/x/Library/Application Support/cmux/cmux.sock',
      cmuxBundledCli: '/Applications/cmux.app/Contents/Resources/cmux',
    });
  });

  it('captures the Herdr socket + pane + workspace for a Herdr host', () => {
    expect(
      captureOpenTerminalContext(
        'split',
        {
          HERDR_SOCKET_PATH: '/Users/x/.config/herdr/herdr.sock',
          HERDR_PANE_ID: 'w1:p1',
          HERDR_WORKSPACE_ID: 'w1',
          // Herdr runs inside iTerm2 — detection must still pick Herdr.
          TERM_PROGRAM: 'iTerm.app',
        },
        CWD,
      ),
    ).toEqual({
      host: 'herdr',
      mode: 'split',
      cwd: CWD,
      herdrSocket: '/Users/x/.config/herdr/herdr.sock',
      herdrPaneId: 'w1:p1',
      herdrWorkspaceId: 'w1',
    });
  });

  it('captures an iTerm2 host with no extra handle (osascript drives it)', () => {
    expect(captureOpenTerminalContext('tab', { TERM_PROGRAM: 'iTerm.app' }, CWD)).toEqual({
      host: 'iterm2',
      mode: 'tab',
      cwd: CWD,
    });
  });
});
