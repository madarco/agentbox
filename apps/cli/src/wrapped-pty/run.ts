import { spawn, spawnSync } from 'node:child_process';
import { readBoxStatus } from '@agentbox/sandbox-docker';
import type { AttachOpenIn } from '@agentbox/config';
import { loadPtyBackend } from '../pty/pty-backend.js';
import { detectHostTerminal, spawnInNewTerminal } from '../terminal/host.js';
import { popTerminalTitle, pushTerminalTitle, setTerminalTitle } from '../terminal/title.js';
import {
  createInputRouter,
  type InputRouter,
  type LeaderAction,
} from './input-router.js';
import {
  ALERT_BAND_ROWS,
  CURSOR_RESTORE,
  CURSOR_SAVE,
  cursorMoveTo,
  renderAlertBand,
  renderFooter,
  SYNC_BEGIN,
  SYNC_END,
  type AlertBandState,
  type FooterState,
} from './footer.js';
import { postAnswer, subscribePrompts, type PromptStream } from './prompt-client.js';
import type { BoxNoticeEvent, PromptAskEvent } from '@agentbox/relay';
import type { ClaudeQuestionPayload } from '@agentbox/ctl';

export interface WrappedAttachOptions {
  /** Docker container name (only used for log lines). */
  container: string;
  /** Full docker argv (e.g. result of buildClaudeAttachArgv). */
  dockerArgv: string[];
  /**
   * The program to spawn for the PTY. Defaults to `'docker'` (the historical
   * behavior; `dockerArgv` is then the docker subcommand argv). Cloud boxes
   * pass `'ssh'` with the Daytona SSH argv instead.
   */
  command?: string;
  /** Extra env merged over `process.env` for the spawned child (e.g. the
   *  Vercel provider's `VERCEL_AUTH_TOKEN` for the `sbx` CLI). */
  env?: Record<string, string>;
  /** Relay base URL — http://127.0.0.1:8787 in normal use. */
  relayBaseUrl: string;
  boxId: string;
  /** Friendly box name; rendered in the idle footer. */
  boxName: string;
  /** Per-project box index (BoxRecord.projectIndex). Used together with
   *  boxId/boxName to read the per-box status.json for the live session
   *  title. Pre-feature boxes lack it; absent is fine. */
  projectIndex?: number;
  /** Mode label affects the idle footer state label only. */
  mode: 'claude' | 'shell' | 'codex' | 'opencode';
  /** Whether the inner session can be detached (tmux-backed). Drives the
   *  `Ctrl+a d` detach chord + footer hint. Defaults to `mode === 'claude'`
   *  (claude is always tmux-backed); a tmux-backed `agentbox shell` passes
   *  `true`, a `--no-tmux` shell leaves it false. */
  detachable?: boolean;
  /** Optional notice printed to stdout *after* the pty exits with code 0
   *  (mirrors today's `formatDetachNotice` for `agentbox claude`). */
  detachNotice?: string;
  /** Optional sink for non-fatal errors that we'd otherwise swallow (Ctrl+a
   *  action spawn failures, status-poll failures, unexpected prompt-capture
   *  rejections). Callers wire this to their command log so post-mortem
   *  inspection isn't blind. */
  onError?: (msg: string) => void;
  /** Where to open the attached session. When set to anything other than
   *  `same` (or undefined) and the host shell is running inside tmux or iTerm2,
   *  the attach runs in a fresh pane/tab/window and this function returns 0
   *  without taking over the current terminal. Outside tmux/iTerm2 it falls
   *  back to inline attach (the original behavior). */
  openIn?: AttachOpenIn;
  /** Optional host→box clipboard image paste, invoked when the user presses
   *  Ctrl+V (wired for claude only). Ships the host clipboard image into the
   *  box and loads it into the box's X11 clipboard; resolves with the outcome
   *  so the footer can flash a result. The input router re-emits Ctrl+V after
   *  this settles, so Claude Code reads the now-loaded clipboard. Omitted →
   *  Ctrl+V forwards verbatim. */
  onPasteImage?: () => Promise<'pasted' | 'no-image' | 'error'>;
}

const FOOTER_ROWS = 1;
/** Min visible inner-PTY rows below which we collapse the band back into the
 *  one-line footer (today's behavior). Keeps a tiny terminal usable instead of
 *  driving the inner program to a 0-row pane. */
const MIN_INNER_ROWS = 5;
const STATUS_POLL_INTERVAL_MS = 3000;
/** Spinner advance cadence while a `notice` footer is active. */
const SPINNER_INTERVAL_MS = 120;
/** How long the post-action confirmation flash stays in the footer. */
const FLASH_DURATION_MS = 2000;

/** Per-action confirmation text shown in the footer flash. */
const ACTION_FLASH: Record<Exclude<LeaderAction, 'detach'>, string> = {
  screen: 'Opening noVNC viewer…',
  code: 'Launching VS Code / Cursor…',
  url: 'Opening box URL…',
};

/** Per-action `agentbox` subcommand: `<sub> <boxId> <...flags>`. */
const ACTION_CMD: Record<
  Exclude<LeaderAction, 'detach'>,
  { sub: string; flags: string[] }
> = {
  screen: { sub: 'screen', flags: [] },
  // --no-wait: don't block on `wait-ready` — the box is already running.
  code: { sub: 'code', flags: ['--no-wait'] },
  url: { sub: 'url', flags: [] },
};

/** Recursive `agentbox <agent> attach <box> --attach-in same` argv for the
 *  new-pane re-entry. Returns null for modes that don't have an `attach`
 *  subcommand (notably `shell`), so the caller can skip new-pane spawning. */
function buildAgentboxAttachArgv(
  mode: WrappedAttachOptions['mode'],
  boxName: string,
): string[] | null {
  if (mode !== 'claude' && mode !== 'codex' && mode !== 'opencode') return null;
  return [mode, 'attach', boxName, '--attach-in', 'same'];
}

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
  const command = opts.command ?? 'docker';
  const logErr = (msg: string): void => {
    opts.onError?.(msg);
  };

  // Open-in-new-terminal short-circuit: if the user asked for split/window/tab
  // and we're inside tmux or iTerm2, re-invoke `agentbox <agent> attach <box>
  // --attach-in same` in a fresh pane so the new pane runs the full wrapper
  // (footer + prompt channel) against the already-prepared session — same UX
  // as inline, just in a new pane. The host process then exits 0. Unknown
  // hosts, shell mode (no attach subcommand to recurse into), and spawn
  // failures fall through to the inline attach below.
  const openIn = opts.openIn ?? 'same';
  if (openIn !== 'same') {
    const subArgv = buildAgentboxAttachArgv(opts.mode, opts.boxName);
    const host = subArgv ? detectHostTerminal() : 'unknown';
    if (subArgv && host !== 'unknown' && process.argv[1]) {
      const r = await spawnInNewTerminal({
        host,
        mode: openIn,
        argv: [process.execPath, process.argv[1], ...subArgv],
        cwd: process.cwd(),
        title: opts.boxName,
      });
      if (r.launched) {
        process.stdout.write(r.note + '\n');
        return 0;
      }
      if (r.error) logErr(r.error);
      // fall through to inline attach
    }
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-interactive path: piping / scripts. Don't wrap — preserves
    // machine-readable stdout, no footer corruption.
    return runFallback(command, opts.dockerArgv, opts.env);
  }
  const backend = await loadPtyBackend();
  if (!backend) {
    // One-line stderr notice; preserves current behavior bit-for-bit.
    process.stderr.write(
      'agentbox: permission prompts disabled (node-pty backend unavailable)\n',
    );
    return runFallback(command, opts.dockerArgv, opts.env);
  }

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const innerRows = Math.max(1, rows - FOOTER_ROWS);

  const pty = backend.ptySpawn(command, opts.dockerArgv, {
    name: 'xterm-256color',
    cols,
    rows: innerRows,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });

  // Mirror the agent's session title to the host terminal/tab title (iTerm2
  // etc.). tmux swallows the inner OSC title (set-titles off), so the host
  // never sees it; we re-emit it ourselves from the polled status below. Save
  // the user's current title first so teardown can restore it. Seed with the
  // box name so the tab is named immediately, before the first status poll.
  pushTerminalTitle();
  let lastEmittedTitle = opts.boxName;
  setTerminalTitle(lastEmittedTitle);

  // claude is always tmux-backed; a tmux-backed `agentbox shell` opts in via
  // `detachable: true`, a `--no-tmux` shell leaves it false (nothing to detach).
  const detachable = opts.detachable ?? opts.mode === 'claude';

  // Idle footer = dashboard's statusLine() with a single hint (`Control+a:
  // Actions`, expanding to the chord menu while the leader is open). Session
  // title + claude activity come from the per-box status.json polled below.
  let leaderActive = false;
  const buildIdle = (sessionTitle?: string, claudeActivity?: string): FooterState => ({
    kind: 'idle',
    boxName: opts.boxName,
    sessionTitle,
    claudeActivity,
    mode: opts.mode,
    detachable,
    leaderActive,
  });
  let footerState: FooterState = buildIdle();
  let lastSessionTitle: string | undefined;
  let lastActivity: string | undefined;
  // Prompt + notice + question feed the alert band above the footer; flash +
  // leader stay in the footer. `recomputeFooter` keeps the footer at idle/flash;
  // `recomputeBand` derives the band visibility from prompt > notice > question.
  let capturingPrompt: PromptAskEvent | null = null;
  let activeNotice: BoxNoticeEvent | null = null;
  let noticeFrame = 0;
  let questionPayload: ClaudeQuestionPayload | null = null;
  let bandState: AlertBandState | null = null;
  let bandReservedRows = 0; // 0 or ALERT_BAND_ROWS depending on band visibility
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  // Transient confirmation shown after a Ctrl+a action fires.
  let flashMessage: string | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reserved rows above the inner pty: footer (always 1) + band (3 or 0). */
  const reservedRows = (): number => FOOTER_ROWS + bandReservedRows;
  /** Whether the current terminal has room for the band without collapsing
   *  the inner pty below `MIN_INNER_ROWS`; gates the band on tiny terminals. */
  const bandFits = (): boolean => {
    const rs = process.stdout.rows ?? rows;
    return rs - FOOTER_ROWS - ALERT_BAND_ROWS >= MIN_INNER_ROWS;
  };

  // Lazy SGR mirror: when the inner pty's most recent attribute is bright
  // bold, our footer paint won't reset it correctly via the inner program's
  // next byte. We always end the chrome with SGR reset, but the inner program
  // may be in the middle of a graphics run when the redraw happens — wrap the
  // redraw in cursor save/restore + sync output so the inner program never
  // sees our cursor moves and the user sees one atomic frame.
  const redrawChrome = (): void => {
    const cs = process.stdout.columns ?? cols;
    const rs = process.stdout.rows ?? rows;
    const footerLine = renderFooter(footerState, cs);
    let payload = SYNC_BEGIN + CURSOR_SAVE;
    if (bandReservedRows > 0 && bandState) {
      const bandLines = renderAlertBand(bandState, cs, bandReservedRows);
      for (let i = 0; i < bandLines.length; i++) {
        const row = rs - FOOTER_ROWS - (bandLines.length - i);
        payload += cursorMoveTo(row + 1, 1) + bandLines[i];
      }
    }
    payload += cursorMoveTo(rs, 1) + footerLine + CURSOR_RESTORE + SYNC_END;
    process.stdout.write(payload);
  };

  // Derive `footerState` from flash > leader/idle. Prompt/notice/question are
  // surfaced in the alert band above the footer (see `recomputeBand`); the
  // footer keeps showing the calm status bar so the user always has context.
  // **Min-size fallback**: when the band collapses on a tiny terminal
  // (`bandReservedRows === 0` while `bandState != null`), prompt and notice
  // fall back to the pre-band footer-replacement so they're not lost (the
  // question state has no one-line footer renderer — sidebar marker only).
  const recomputeFooter = (): void => {
    const collapsed = bandState !== null && bandReservedRows === 0;
    if (collapsed && capturingPrompt) {
      footerState = { kind: 'prompt', prompt: capturingPrompt };
    } else if (collapsed && activeNotice) {
      footerState = { kind: 'notice', message: activeNotice.message, frame: noticeFrame };
    } else if (flashMessage) {
      footerState = { kind: 'flash', message: flashMessage };
    } else {
      footerState = buildIdle(lastSessionTitle, lastActivity);
    }
  };

  // Derive the band's content + visibility from prompt > notice > question.
  // Priority chain: a relay prompt hard-blocks an in-box RPC (most urgent);
  // a notice means the box is frozen for a snapshot (loud animated banner);
  // a question is the agent waiting for the user. When nothing is active the
  // band collapses entirely.
  const recomputeBand = (): void => {
    if (capturingPrompt) {
      bandState = { kind: 'prompt', prompt: capturingPrompt };
    } else if (activeNotice) {
      bandState = { kind: 'notice', message: activeNotice.message, frame: noticeFrame };
    } else if (questionPayload) {
      bandState = { kind: 'question', question: questionPayload };
    } else {
      bandState = null;
    }
  };

  /** Resize the inner pty + reapply the scroll region for the current reserved
   *  rows, then clear any rows that just changed ownership (the freed region
   *  when the band collapses; the band area itself when it appears). Called
   *  after `recomputeBand` whenever the band visibility flips. */
  const relayoutForBand = (): void => {
    const cs = process.stdout.columns ?? cols;
    const rs = process.stdout.rows ?? rows;
    const inner = Math.max(1, rs - reservedRows());
    pty.resize(cs, inner);
    process.stdout.write(`\x1b[1;${String(inner)}r`);
    // Clear the chrome area (band + footer rows) so stale agent output left
    // over from the previous scroll region doesn't show through under the
    // newly painted band/footer.
    let clear = SYNC_BEGIN + CURSOR_SAVE;
    for (let r = inner + 1; r <= rs; r++) clear += cursorMoveTo(r, 1) + '\x1b[2K';
    clear += CURSOR_RESTORE + SYNC_END;
    process.stdout.write(clear);
  };

  /** Re-derive the band state and, if visibility changed, resize + reflow.
   *  Always finishes with a chrome redraw so the band/footer are repainted.
   *  Also re-derives the footer so the min-size fallback (prompt/notice in
   *  the footer when the band collapses) keeps in sync. */
  const applyBandChange = (): void => {
    recomputeBand();
    const wantRows = bandState && bandFits() ? ALERT_BAND_ROWS : 0;
    if (wantRows !== bandReservedRows) {
      bandReservedRows = wantRows;
      relayoutForBand();
    }
    recomputeFooter();
    redrawChrome();
  };

  const startSpinner = (): void => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      noticeFrame++;
      // Advance the spinner frame whenever a notice is the live band; if the
      // notice was outranked by a prompt the frame still advances so it
      // resumes mid-animation when the prompt clears.
      if (bandState?.kind === 'notice') {
        bandState = { kind: 'notice', message: bandState.message, frame: noticeFrame };
        // When the band is collapsed on a tiny terminal the notice renders
        // through `footerState` instead, so re-derive it to pick up the new
        // frame — otherwise the footer-fallback spinner glyph freezes.
        if (bandReservedRows === 0) recomputeFooter();
        redrawChrome();
      }
    }, SPINNER_INTERVAL_MS);
    if (typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
  };
  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
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
    redrawChrome();
  });

  // Ctrl+a leader chord map — keys mirror the dashboard's (`c`/`s`/`u`).
  // A detachable (tmux-backed) session also gets `d: detach`; a plain
  // `--no-tmux` shell has nothing to detach from.
  const leaderChords: Record<string, LeaderAction> = detachable
    ? { c: 'code', s: 'screen', u: 'url', d: 'detach' }
    : { c: 'code', s: 'screen', u: 'url' };

  // Run a Ctrl+a leader action. `detach` writes the tmux detach sequence to
  // the pty (`\x02` = Ctrl+b, tmux's secondary prefix; `d` = detach-client) —
  // the attach process then exits 0 and teardown runs normally. The other
  // actions shell out to the real `agentbox` subcommand, detached, so the
  // long-running open/launch never blocks (or corrupts) this terminal.
  const runAction = (name: LeaderAction): void => {
    if (name === 'detach') {
      pty.write('\x02d');
      return;
    }
    const cliEntry = process.argv[1];
    if (typeof cliEntry === 'string' && cliEntry.length > 0) {
      const cmd = ACTION_CMD[name];
      try {
        spawn(
          process.execPath,
          [cliEntry, cmd.sub, opts.boxId, ...cmd.flags],
          { detached: true, stdio: 'ignore' },
        ).unref();
      } catch (e) {
        // Best-effort — the footer flash still shows. Surface for inspection.
        logErr(`leader-action spawn (${name}) failed: ${(e as Error).message}`);
      }
    }
    flashMessage = ACTION_FLASH[name];
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      flashMessage = null;
      recomputeFooter();
      redrawChrome();
    }, FLASH_DURATION_MS);
    if (typeof flashTimer.unref === 'function') flashTimer.unref();
    recomputeFooter();
    redrawChrome();
  };

  // Ctrl+V image paste: hold a "Pasting image…" notice in the footer while the
  // host clipboard image is shipped into the box, then flash the outcome. The
  // input router re-emits the Ctrl+V once this resolves, so Claude reads the
  // now-loaded box clipboard. Never throws — failures degrade to a flash.
  const handlePasteImage = async (): Promise<void> => {
    if (!opts.onPasteImage) return;
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    flashMessage = 'Pasting image…';
    recomputeFooter();
    redrawChrome();
    let result: 'pasted' | 'no-image' | 'error' = 'error';
    try {
      result = await opts.onPasteImage();
    } catch (e) {
      logErr(`paste-image failed: ${(e as Error).message}`);
    }
    flashMessage =
      result === 'pasted'
        ? 'Image pasted'
        : result === 'no-image'
          ? 'No image in clipboard'
          : 'Image paste failed';
    flashTimer = setTimeout(() => {
      flashTimer = null;
      flashMessage = null;
      recomputeFooter();
      redrawChrome();
    }, FLASH_DURATION_MS);
    if (typeof flashTimer.unref === 'function') flashTimer.unref();
    recomputeFooter();
    redrawChrome();
  };

  // Wire stdin -> pty (through the router so prompts + the leader can intercept).
  const router: InputRouter = createInputRouter({
    onForward: (b) => {
      // node-pty wants utf8 strings; stdin is binary safe via Buffer.
      pty.write(b.toString('utf8'));
    },
    onAnswer: (body) => {
      // Fire-and-forget; the relay-side route is idempotent. We don't
      // block the input flow on the network roundtrip.
      void postAnswer({ relayBaseUrl: opts.relayBaseUrl, body });
      capturingPrompt = null;
      applyBandChange();
    },
    leaderChords,
    onLeaderChange: (open) => {
      leaderActive = open;
      recomputeFooter();
      redrawChrome();
    },
    onAction: (name) => {
      runAction(name);
    },
    onPasteImage: opts.onPasteImage ? handlePasteImage : undefined,
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const onStdinData = (chunk: Buffer): void => {
    router.feed(chunk);
  };
  process.stdin.on('data', onStdinData);

  // Resize: keep the pty `reservedRows` shorter than the host terminal; the
  // footer owns the last row directly and the band (when active) owns the 3
  // rows above it. Re-apply the scroll region too — most terminals reset
  // DECSTBM on resize. The bandFits() check downgrades band → 0 if the new
  // size is too small to host both.
  const onResize = (): void => {
    const cs = process.stdout.columns ?? cols;
    const rs = process.stdout.rows ?? rows;
    // Re-evaluate band visibility against the new size first; a now-too-small
    // terminal collapses the band, a now-big-enough one re-opens it. Refresh
    // the footer so the collapsed-band fallback (prompt/notice in the footer)
    // tracks the new reserve.
    bandReservedRows = bandState && bandFits() ? ALERT_BAND_ROWS : 0;
    const inner = Math.max(1, rs - reservedRows());
    pty.resize(cs, inner);
    process.stdout.write(`\x1b[1;${String(inner)}r`);
    recomputeFooter();
    redrawChrome();
  };
  process.stdout.on('resize', onResize);

  // SSE: subscribe to the relay's prompt stream for this box.
  const stream: PromptStream = subscribePrompts({
    relayBaseUrl: opts.relayBaseUrl,
    boxId: opts.boxId,
    onPrompt: (ev: PromptAskEvent) => {
      capturingPrompt = ev;
      applyBandChange();
      // capture() returns a Promise that resolves with the answer body; the
      // input-router's onAnswer callback already POSTs and resets the band.
      // We just need to await so unhandled rejections (router.abort) don't
      // crash the process.
      router.capture(ev).catch((e: unknown) => {
        // Expected reasons: sibling answered ('resolved-elsewhere'), pty exit.
        // Anything else is a real bug worth surfacing.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== 'resolved-elsewhere') {
          logErr(`prompt capture rejected: ${msg}`);
        }
      });
    },
    onResolved: (id: string) => {
      // Clear band if it's still showing this id (sibling wrapper won).
      if (capturingPrompt && capturingPrompt.id === id) {
        capturingPrompt = null;
        router.abort('resolved-elsewhere');
        applyBandChange();
      }
    },
    onNotice: (ev: BoxNoticeEvent) => {
      activeNotice = ev;
      startSpinner();
      applyBandChange();
    },
    onNoticeCleared: (id: string) => {
      if (activeNotice && activeNotice.id === id) {
        activeNotice = null;
        stopSpinner();
        applyBandChange();
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
      // Read the title/activity from the body of the agent we attached to;
      // shell mode has no agent session so it keeps the box-name title.
      const body =
        opts.mode === 'codex'
          ? status?.codex
          : opts.mode === 'opencode'
            ? status?.opencode
            : opts.mode === 'shell'
              ? undefined
              : status?.claude;
      const nextTitle = body?.sessionTitle?.trim() || undefined;
      const nextActivity = body?.state || undefined;
      // Mirror the live title to the host terminal/tab, falling back to the box
      // name until the agent sets one. Deduped so we don't spam the terminal.
      const desiredTitle = nextTitle ?? opts.boxName;
      if (desiredTitle !== lastEmittedTitle) {
        lastEmittedTitle = desiredTitle;
        setTerminalTitle(desiredTitle);
      }
      // Surface claude's AskUserQuestion payload to the band when the agent
      // is in `question` state; clear it on any other state. Only meaningful
      // for claude mode (codex/opencode have no question payload). The band's
      // priority chain (`recomputeBand`) demotes question below prompt/notice,
      // so it only shows when nothing more urgent is pending.
      const nextQuestion =
        opts.mode === 'claude' && status?.claude.state === 'question'
          ? (status.claude.question ?? null)
          : null;
      const questionChanged =
        (nextQuestion?.capturedAt ?? null) !== (questionPayload?.capturedAt ?? null);
      if (questionChanged) {
        questionPayload = nextQuestion;
        applyBandChange();
      }
      if (nextTitle === lastSessionTitle && nextActivity === lastActivity) return;
      lastSessionTitle = nextTitle;
      lastActivity = nextActivity;
      if (footerState.kind === 'idle') {
        recomputeFooter();
        redrawChrome();
      }
    } catch (e) {
      // readBoxStatus already swallows the common cases (paused/stopped/pre-feature);
      // anything reaching here is unexpected and worth a log line.
      logErr(`status poll failed: ${(e as Error).message}`);
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

  // Plain shell (`--no-tmux`): bash doesn't enter alt-screen, so without help
  // the user's pre-shell host-terminal content stays visible above bash's
  // freshly drawn prompt. Clear the visible screen + home the cursor before
  // the pty's first write. We don't touch scrollback (`\x1b[3J`) — the user's
  // pre-shell context stays scroll-up-able. Claude and the tmux-backed shell
  // skip this: they enter their own alt-screen on init and would just
  // overpaint anyway (clearing first would only flicker).
  if (opts.mode === 'shell' && !detachable) {
    process.stdout.write('\x1b[H\x1b[2J');
  }

  // Initial paint so the idle footer appears immediately.
  redrawChrome();

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
  stopSpinner();
  if (flashTimer) clearTimeout(flashTimer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  stream.close();
  router.dispose();
  const rsFinal = process.stdout.rows ?? rows;
  const csFinal = process.stdout.columns ?? cols;
  // Clear the scroll region first so the cursor moves below can reach row N
  // without the terminal trying to keep them inside the smaller region.
  // Then erase every row owned by chrome (band + footer) so a stale band
  // doesn't sit above the next shell prompt; return the cursor afterwards.
  let teardownPaint = '\x1b[r';
  for (let r = rsFinal - bandReservedRows; r <= rsFinal; r++) {
    if (r >= 1) teardownPaint += cursorMoveTo(r, 1) + '\x1b[2K';
  }
  teardownPaint += cursorMoveTo(rsFinal, csFinal);
  process.stdout.write(teardownPaint);
  // Restore the host terminal/tab title we saved at attach time.
  popTerminalTitle();

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
function runFallback(command: string, argv: string[], env?: Record<string, string>): number {
  const child = spawnSync(command, argv, {
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return child.status ?? 0;
}
