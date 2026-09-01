import { describe, expect, it } from 'vitest';
import { browserSessionActive, desktopOpenCommand } from '../src/browser.js';

describe('browserSessionActive', () => {
  it('is false when agent-browser reports no active sessions', () => {
    expect(browserSessionActive('No active sessions\n', 0)).toBe(false);
  });

  it('is case-insensitive on the no-sessions sentinel', () => {
    expect(browserSessionActive('no active sessions', 0)).toBe(false);
  });

  it('is true when a session is listed on a clean exit', () => {
    expect(browserSessionActive('default  about:blank  (running)\n', 0)).toBe(true);
  });

  it('is false on a non-zero exit even if stdout looks like a session list', () => {
    expect(browserSessionActive('default  about:blank', 1)).toBe(false);
  });

  it('is false on an empty stdout with a non-zero exit', () => {
    expect(browserSessionActive('', -1)).toBe(false);
  });
});

describe('desktopOpenCommand', () => {
  const cmd = desktopOpenCommand('https://app.localhost/x');

  it('prefers the desktop launcher and backgrounds it', () => {
    // Backgrounded because the launcher outlives the exec: its progress window
    // stays up for the whole first-launch Chromium download.
    expect(cmd).toMatch(/if \[ -x "\$HOME\/\.local\/share\/agentbox\/desktop\/open-browser" \]/);
    expect(cmd).toMatch(/nohup .* >\/dev\/null 2>&1 & exit 0/);
  });

  it('falls back to a foreground agent-browser when the launcher is absent', () => {
    // Foreground so the fallback's exit code still reaches the caller.
    expect(cmd).toMatch(/exec agent-browser open --headed '/);
    expect(cmd).not.toMatch(/nohup agent-browser/);
  });

  it('quotes the target on both branches', () => {
    expect(cmd.match(/'https:\/\/app\.localhost\/x'/g)).toHaveLength(2);
    expect(desktopOpenCommand("a'b")).toContain(`'a'\\''b'`);
  });
});
