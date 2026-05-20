import { spawnSync } from 'node:child_process';
import { readBoxStatus } from '@agentbox/sandbox-docker';
import { loadPtyBackend } from '../pty/pty-backend.js';
import { createInputRouter, type InputRouter } from './input-router.js';
import {
  CURSOR_RESTORE,
  CURSOR_SAVE,
  cursorMoveTo,
  renderFooter,
  SYNC_BEGIN,
  SYNC_END,
  type FooterState,
} from './footer.js';
import { postAnswer, subscribePrompts, type PromptStream } from './prompt-client.js';
import type { PromptAskEvent } from '@agentbox/relay';

export interface WrappedAttachOptions {
  /** Docker container name (only used for log lines). */
  container: string;
  /** Full docker argv (e.g. result of buildClaudeAttachArgv). */
  dockerArgv: string[];
  /** Relay base URL — http://127.0.0.1:8787 in normal use. */
  relayBaseUrl: string;
  boxId: string;
  /** Friendly box name; rendered in the idle footer. */
  boxName: string;
  /** Per-project box index (BoxRecord.projectIndex). Used together with
   *  boxId/boxName to read the per-box status.json for the live session
   *  title. Pre-feature boxes lack it; absent is fine. */
  projectIndex?: number;
  /** Mode label affects the idle footer text only. */
  mode: 'claude' | 'shell';
  /** Optional notice printed to stdout *after* the pty exits with code 0
   *  (mirrors today's `formatDetachNotice` for `agentbox claude`). */
  detachNotice?: string;
}

const FOOTER_ROWS = 1;
const STATUS_POLL_INTERVAL_MS = 3000;

/**
 * Replace `spawnSync('docker', argv, { stdio: 'inherit' })` with a
 * node-pty wrapper that reserves the bottom row for a permission-prompt
 * footer. Falls back transparently to today's spawnSync behavior when
 * node-pty isn't available (optional dep missing), or when stdin/stdout
 * isn't a TTY (piping / non-interactive use).
 *
 * Returns the pty's exit code; caller `process.exit`s with it.
 */
export async function runWrappedAttach(opts: WrappedAttachOptions): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-interactive path: piping / scripts. Don't wrap — preserves
    // machine-readable stdout, no footer corruption.
    return runFallback(opts.dockerArgv);
  }
  const backend = await loadPtyBackend();
  if (!backend) {
    // One-line stderr notice; preserves current behavior bit-for-bit.
    process.stderr.write(
      'agentbox: permission prompts disabled (node-pty backend unavailable)\n',
    );
    return runFallback(opts.dockerArgv);
  }

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const innerRows = Math.max(1, rows - FOOTER_ROWS);

  const pty = backend.ptySpawn('docker', opts.dockerArgv, {
    name: 'xterm-256color',
    cols,
    rows: innerRows,
    env: process.env,
  });

  // Idle footer = dashboard's statusLine() with a single hint (Ctrl+a q
  // for claude; none for shell). Session title + claude activity come from
  // the per-box status.json polled below.
  const buildIdle = (sessionTitle?: string, claudeActivity?: string): FooterState => ({
    kind: 'idle',
    boxName: opts.boxName,
    sessionTitle,
    claudeActivity,
    mode: opts.mode,
  });
  let footerState: FooterState = buildIdle();
  let lastSessionTitle: string | undefined;
  let lastActivity: string | undefined;

  // Lazy SGR mirror: when the inner pty's most recent attribute is bright
  // bold, our footer paint won't reset it correctly via the inner program's
  // next byte. We always end the footer with SGR reset, but the inner
  // program may be in the middle of a graphics run when the footer redraw
  // happens — wrap the redraw in cursor save/restore + sync output so the
  // inner program never sees our cursor moves and the user sees one atomic
  // frame.
  const redrawFooter = (): void => {
    const cs = process.stdout.columns ?? cols;
    const rs = process.stdout.rows ?? rows;
    const line = renderFooter(footerState, cs);
    // Position at the last row, then write. Save/restore around the lot so
    // the inner pty's cursor doesn't move.
    const payload =
      SYNC_BEGIN +
      CURSOR_SAVE +
      cursorMoveTo(rs, 1) +
      line +
      CURSOR_RESTORE +
      SYNC_END;
    process.stdout.write(payload);
  };

  // Wire pty -> stdout. The inner program writes raw bytes; we forward as-is.
  // The outer terminal has `rows` real rows, but the pty thinks it has `innerRows`.
  // The inner program's writes can still physically touch row `rows` (our footer
  // row) via: (1) scroll when its bottom line emits a newline — the terminal
  // scrolls the whole screen and row `rows` gets cleared; (2) clear-screen
  // sequences like `\x1b[2J`; (3) alt-screen entry `\x1b[?1049h`; (4) column
  // wraparound from the inner program's last row. The scroll-region setup
  // below limits (1); always-repaint here handles the rest. Each redraw is
  // wrapped in synchronized output (DECSET 2026) so the user never sees a
  // half-painted frame on terminals that support it (iTerm2/WezTerm/kitty/
  // Apple Terminal/Ghostty).
  pty.onData((d: string) => {
    process.stdout.write(d);
    redrawFooter();
  });

  // Wire stdin -> pty (through the router so prompts can intercept).
  const router: InputRouter = createInputRouter({
    onForward: (b) => {
      // node-pty wants utf8 strings; stdin is binary safe via Buffer.
      pty.write(b.toString('utf8'));
    },
    onAnswer: (body) => {
      // Fire-and-forget; the relay-side route is idempotent. We don't
      // block the input flow on the network roundtrip.
      void postAnswer({ relayBaseUrl: opts.relayBaseUrl, body });
      footerState = buildIdle(lastSessionTitle, lastActivity);
      redrawFooter();
    },
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const onStdinData = (chunk: Buffer): void => {
    router.feed(chunk);
  };
  process.stdin.on('data', onStdinData);

  // Resize: keep the pty one row shorter than the host terminal; the footer
  // owns the last row directly. Re-apply the scroll region too — most
  // terminals reset DECSTBM on resize.
  const onResize = (): void => {
    const cs = process.stdout.columns ?? cols;
    const rs = process.stdout.rows ?? rows;
    const inner = Math.max(1, rs - FOOTER_ROWS);
    pty.resize(cs, inner);
    process.stdout.write(`\x1b[1;${String(inner)}r`);
    redrawFooter();
  };
  process.stdout.on('resize', onResize);

  // SSE: subscribe to the relay's prompt stream for this box.
  const stream: PromptStream = subscribePrompts({
    relayBaseUrl: opts.relayBaseUrl,
    boxId: opts.boxId,
    onPrompt: (ev: PromptAskEvent) => {
      footerState = { kind: 'prompt', prompt: ev };
      redrawFooter();
      // capture() returns a Promise that resolves with the answer body; the
      // input-router's onAnswer callback already POSTs and resets the footer.
      // We just need to await so unhandled rejections (router.abort) don't
      // crash the process.
      router.capture(ev).catch(() => {
        /* aborted — sibling answered, or pty exited. State already reset. */
      });
    },
    onResolved: (id: string) => {
      // Clear footer if it's still showing this id (sibling wrapper won).
      if (footerState.kind === 'prompt' && footerState.prompt.id === id) {
        router.abort('resolved-elsewhere');
        footerState = buildIdle(lastSessionTitle, lastActivity);
        redrawFooter();
      }
    },
  });

  // Poll the box's status.json for `claude.sessionTitle` so the idle
  // footer can show what claude set as its terminal title (mirrors the
  // dashboard's sidebar entry). Best-effort — paused/stopped boxes and
  // pre-status-feature boxes return null and we just keep the previous
  // title (or no title).
  const pollStatus = async (): Promise<void> => {
    try {
      const status = await readBoxStatus({
        id: opts.boxId,
        name: opts.boxName,
        projectIndex: opts.projectIndex,
      });
      const nextTitle = status?.claude?.sessionTitle?.trim() || undefined;
      const nextActivity = status?.claude?.state || undefined;
      if (nextTitle === lastSessionTitle && nextActivity === lastActivity) return;
      lastSessionTitle = nextTitle;
      lastActivity = nextActivity;
      if (footerState.kind === 'idle') {
        footerState = buildIdle(lastSessionTitle, lastActivity);
        redrawFooter();
      }
    } catch {
      /* readBoxStatus already swallows errors; this catch is belt-and-suspenders */
    }
  };
  void pollStatus();
  const statusTimer = setInterval(() => {
    void pollStatus();
  }, STATUS_POLL_INTERVAL_MS);
  if (typeof statusTimer.unref === 'function') statusTimer.unref();

  // Restrict the outer terminal's scroll region to rows 1..innerRows so the
  // inner program's natural scrolling (bottom-line newline) doesn't push
  // content into our footer row. DECSTBM also resets the cursor to (1,1) on
  // some terminals, so we follow it with a cursor restore. Reverted in
  // teardown via `\x1b[r` (clear scroll region -> full screen).
  process.stdout.write(`\x1b[1;${String(innerRows)}r`);

  // Shell mode: bash doesn't enter alt-screen, so without help the user's
  // pre-shell host-terminal content stays visible above bash's freshly
  // drawn prompt. Clear the visible screen + home the cursor before the
  // pty's first write. We don't touch scrollback (`\x1b[3J`) — the user's
  // pre-shell context stays scroll-up-able. Claude mode skips this: claude
  // enters its own alt-screen on init and would just overpaint anyway.
  if (opts.mode === 'shell') {
    process.stdout.write('\x1b[H\x1b[2J');
  }

  // Initial paint so the idle footer appears immediately.
  redrawFooter();

  // Wait for the pty to exit, then tear down everything.
  const exitCode = await new Promise<number>((resolve) => {
    pty.onExit(({ exitCode }) => resolve(exitCode));
  });

  // Teardown order: stop reading stdin, restore cooked mode, drop SSE,
  // dispose the router (rejects any in-flight capture), clear the footer
  // row so the shell prompt below doesn't sit on top of our bar.
  process.stdin.off('data', onStdinData);
  process.stdout.off('resize', onResize);
  clearInterval(statusTimer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  stream.close();
  router.dispose();
  const rsFinal = process.stdout.rows ?? rows;
  const csFinal = process.stdout.columns ?? cols;
  // Clear the scroll region first so the cursor moves below can reach row N
  // without the terminal trying to keep them inside the smaller region.
  // Then move to the footer row, erase it, return the cursor.
  process.stdout.write(
    '\x1b[r' +
      cursorMoveTo(rsFinal, 1) +
      `\x1b[2K` +
      cursorMoveTo(rsFinal, csFinal),
  );

  if (exitCode === 0 && opts.detachNotice) {
    // Match the cosmetic of the old attachClaudeSession: overwrite tmux's
    // own `[detached]` line if it's visible, then print the reattach hint.
    process.stdout.write('\x1b[1A\x1b[2K\r' + opts.detachNotice + '\n');
  }
  return exitCode;
}

/**
 * Fallback when node-pty is unavailable or stdio isn't a TTY. Identical to
 * today's call: blocking spawnSync with inherited stdio.
 */
function runFallback(argv: string[]): number {
  const child = spawnSync('docker', argv, { stdio: 'inherit' });
  return child.status ?? 0;
}
