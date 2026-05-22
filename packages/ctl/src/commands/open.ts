import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { postRpc } from '../relay-rpc.js';

/** Hard cap on the in-box `agent-browser open` so a wedged launch can't hang xdg-open. */
const OPEN_TIMEOUT_MS = 30_000;

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Open the URL in the box's own Chromium via agent-browser. `agent-browser
 * open` starts the persistent headed session on first call and reuses it
 * after — so this both ensures the browser is running and navigates it. It
 * renders to DISPLAY=:1, i.e. the VNC view (`agentbox screen`).
 */
function openInBoxBrowser(url: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('agent-browser', ['open', '--headed', url], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      process.stderr.write(
        `agentbox-ctl open: agent-browser timed out after ${String(OPEN_TIMEOUT_MS)}ms\n`,
      );
      resolve(124);
    }, OPEN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`agentbox-ctl open: ${String(err.message ?? err)}\n`);
      resolve(126);
    });
  });
}

/**
 * Open a URL in the box's own browser. The relay is then notified so the host
 * user can be offered (in the footer/dashboard) to also open it on the host —
 * but that's optional: the in-box open is the primary action and a missing or
 * unreachable relay must not fail the command.
 */
export const openCommand = new Command('open')
  .description("Open a URL in the box's browser (visible via `agentbox screen`)")
  .argument('<url>', 'http(s) URL to open')
  .action(async (url: string) => {
    if (!isHttpUrl(url)) {
      process.stderr.write(`agentbox-ctl open: only http/https URLs are allowed: ${url}\n`);
      process.exit(64);
    }
    const code = await openInBoxBrowser(url);
    if (code !== 0) process.exit(code);
    // Best-effort relay notification. postRpc never rejects (it resolves with
    // an outcome on transport/env errors), so the in-box open's success is
    // what determines the exit code.
    await postRpc('browser.open', { url }, { errorPrefix: 'agentbox-ctl open' });
    process.exit(0);
  });
