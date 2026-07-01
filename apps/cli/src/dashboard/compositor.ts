import { computeLayout, type DashboardLayout } from './layout.js';
import { diffFrame } from './renderer.js';
import { InputParser } from './input.js';
import {
  PtySession,
  MOUSE_ENABLE_SEQ,
  MOUSE_DISABLE_SEQ,
  EXT_KEYS_ENABLE_SEQ,
  EXT_KEYS_DISABLE_SEQ,
  type PtySpawn,
  type TerminalCtor,
} from './pty-session.js';
import {
  sidebarLines,
  statusLine,
  menuLines,
  lifecycleMenuLines,
  createMenuLines,
  stripTitleGlyph,
  NEW_BOX_ID,
  ADVANCED_HINT_GROUPS,
  type SidebarBox,
} from './sidebar.js';
import { ALERT_BAND_ROWS, renderAlertBand, renderFooter } from '../wrapped-pty/footer.js';
import { popTerminalTitle, pushTerminalTitle, setTerminalTitle } from '../terminal/title.js';
import { postAnswer, subscribePrompts, type PromptStream } from '../wrapped-pty/prompt-client.js';
import type { BoxNoticeEvent, PromptAskEvent } from '@agentbox/relay';

// Sidebar panel styling (256-color, portable). Each sidebar line is already
// padded to the panel width, so wrapping it in a bg SGR tints the full column.
// Background is pure black (truecolor, so terminals can't shade it per
// context); the selected row reads via bold bright-white text + the `▸` marker.
const SB_BG = '\x1b[48;2;0;0;0m';
const SB_BODY = SB_BG + '\x1b[38;5;250m';
const SB_HEADER = SB_BG + '\x1b[38;5;39m\x1b[1m';
const SB_SELECTED = SB_BG + '\x1b[38;5;255m\x1b[1m';
// Bright yellow + bold for non-selected rows that have a pending relay
// prompt — same palette index as the [!] tag in the wrapped-pty footer
// (renderFooter URGENT). Reads as "this box needs your attention".
const SB_PROMPT = SB_BG + '\x1b[38;5;220m\x1b[1m';
// Bright cyan + bold for the agent's own "awaiting input" state
// (activity === 'waiting'). Distinct hue from yellow so the user can
// triage at a glance: yellow ▲ = relay needs a decision NOW; cyan ◐ =
// the agent is idle waiting for the user's direction (less urgent).
const SB_AWAITING = SB_BG + '\x1b[38;5;51m\x1b[1m';
const SGR_RESET = '\x1b[0m';

export type RightTarget =
  | {
      kind: 'attach';
      /** Program to spawn — `'docker'` for docker boxes, `'ssh'` for cloud. */
      command: string;
      /** Args passed to `command` (everything after `argv[0]`). */
      args: string[];
      /** Extra env merged over `process.env` for the spawned attach process.
       *  Required by providers that pass the inner command / credentials through
       *  the environment instead of argv (e2b: `AGENTBOX_E2B_INNER_CMD` +
       *  `E2B_API_KEY`). Dropping it makes the e2b attach helper exit early. */
      env?: NodeJS.ProcessEnv;
      /** Fires when the PtySession is disposed. Used by daytona to revoke the
       *  ephemeral SSH token its `buildAttach` mints. */
      cleanup?: () => Promise<void>;
      mode?: 'claude' | 'shell' | 'codex' | 'opencode';
      /** Keep this session alive (pooled) across box switches instead of
       *  disposing it on switch-away. Set for providers where reconnecting is
       *  expensive and has no per-attach cleanup (vercel) — see the dashboard's
       *  `providerSupportsKeepAlive`. Reconnect-cheap providers (docker,
       *  hetzner ControlMaster) and per-call-token providers (daytona) leave it
       *  unset and keep the dispose-on-switch behaviour. */
      keepAlive?: boolean;
    }
  | { kind: 'menu' }
  | { kind: 'lifecycle-menu'; state: 'paused' | 'stopped' }
  | { kind: 'create-menu'; where: string }
  | { kind: 'placeholder'; lines: string[] };

export interface CompositorDeps {
  ptySpawn: PtySpawn;
  termCtor: TerminalCtor;
  /** Relay base URL the per-box SSE subscriptions hit. Typically
   *  `http://127.0.0.1:8787` (built from DEFAULT_RELAY_PORT). When absent
   *  (legacy callers) the compositor skips prompt subscriptions entirely
   *  — the dashboard still works, just without relay-prompt overlay. */
  relayBaseUrl?: string;
  /** Scoped + sorted candidate boxes (same order the sidebar renders). */
  listCandidates: () => Promise<SidebarBox[]>;
  /** What the right pane should show for a box (attach argv / menu / message). */
  resolveTarget: (boxId: string) => Promise<RightTarget>;
  /** Start a Claude / Codex / OpenCode tmux session in the box, resolve to attach. */
  startClaude: (boxId: string) => Promise<RightTarget>;
  startCodex: (boxId: string) => Promise<RightTarget>;
  startOpencode: (boxId: string) => Promise<RightTarget>;
  /** Open an interactive shell in the box, resolve to attach. */
  openShell: (boxId: string) => Promise<RightTarget>;
  /** Create a new box (config defaults). When `agent` is set, also start that
   *  agent's session + return an attach target; `undefined` = create only.
   *  `onProgress` streams createBox log lines. */
  createNewBox: (
    agent: 'claude' | 'codex' | 'opencode' | undefined,
    onProgress: (line: string) => void,
  ) => Promise<{ boxId: string; attach?: RightTarget }>;
  /** Resume a non-running box (unpause if paused, start if stopped). */
  resumeBox: (boxId: string) => Promise<void>;
  /** Pause a running box. */
  pauseBox: (boxId: string) => Promise<void>;
  /** Stop a running box. */
  stopBox: (boxId: string) => Promise<void>;
  /** Destroy a box (container + volumes + record). Irreversible. */
  destroyBox: (boxId: string) => Promise<void>;
  /** Host-side actions for the selected box; return a short status message. */
  openScreen: (boxId: string) => Promise<string>;
  openCode: (boxId: string) => Promise<string>;
  openUrl: (boxId: string) => Promise<string>;
}

const POLL_MS = 1000;
const FRAME_MS = 16;
/** Max kept-alive (pooled) sessions. Each is a live remote attach process
 *  (e.g. `sbx exec`) + a headless terminal, so the pool is LRU-bounded. */
const KEEP_ALIVE_MAX = 6;
const RESIZE_DEBOUNCE_MS = 120;
/** Keep the expanded chord footer visible this long after the Ctrl-a leader
 *  resolves, so it's actually readable instead of flashing by. */
const LEADER_LINGER_MS = 1500;
/** Spinner advance cadence while a box has an active relay notice. */
const NOTICE_SPINNER_MS = 120;

// Synchronized Output (DECSET 2026): the terminal buffers everything between
// begin/end and presents it in one go — no partial-frame flicker/tearing.
// Unsupported terminals ignore the unknown private mode.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

function cursorTo(x: number, y: number): string {
  return `\x1b[${String(y + 1)};${String(x + 1)}H`;
}

export class Compositor {
  private readonly out = process.stdout;
  private readonly inp = process.stdin;
  private boxes: SidebarBox[] = [];
  private selectedId: string;
  /** The session currently shown in the right pane (may also be in
   *  {@link liveSessions} when it's keep-alive). */
  private session: PtySession | null = null;
  /**
   * Pool of kept-alive sessions, keyed by box id, for providers whose attach
   * is expensive to reconnect (vercel). Hidden entries keep their PTY + headless
   * buffer alive so switching back is instant — no probe, no re-spawn. Map
   * insertion order doubles as LRU recency (re-set on activate); bounded by
   * {@link KEEP_ALIVE_MAX}. Reconnect-cheap providers never enter this map.
   */
  private readonly liveSessions = new Map<string, PtySession>();
  private placeholder: string[] | null = null;
  private menu: { boxName: string } | null = null;
  private lifecycleMenu: {
    boxName: string;
    state: 'paused' | 'stopped';
    confirmDestroy: boolean;
  } | null = null;
  private createMenu: { where: string } | null = null;
  /** True while the Ctrl-a leader is pending — swaps the footer to the
   *  expanded chord menu (chrome only; never touches the right pane). */
  private leaderActive = false;
  /** Holds the expanded footer for LEADER_LINGER_MS after the leader resolves
   *  (so the chord menu doesn't flash by). */
  private leaderLingerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a destroy confirm is pending in the status bar. */
  private pendingConfirm: { boxId: string; name: string } | null = null;
  /**
   * Per-box relay-prompt state. Populated by SSE `prompt-ask` events,
   * cleared by `prompt-resolved` events or by the local user answering.
   * The sidebar reads it to mark rows; drawChrome's status-line picker
   * reads it to swap to [!] mode when the SELECTED box is in this map.
   * Subscriptions are tracked separately in {@link promptStreams} so
   * we can dispose them when boxes disappear from the list.
   */
  private readonly activePrompts = new Map<string, PromptAskEvent>();
  /**
   * Per-box active relay notice (currently: a checkpoint freezing the box).
   * Drives the `◆ checkpoint` sidebar cell and the animated status-bar
   * warning. Shares the SSE subscriptions in {@link promptStreams}.
   */
  private readonly activeNotices = new Map<string, BoxNoticeEvent>();
  /** Monotonic spinner counter for the notice status bar. */
  private noticeFrame = 0;
  /** Drives the spinner animation while {@link activeNotices} is non-empty. */
  private noticeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly promptStreams = new Map<string, PromptStream>();
  private activeMode: 'claude' | 'shell' | 'codex' | 'opencode' = 'claude';
  private flashMsg: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a start-Claude / open-shell action is in flight (suppresses
   * the poll respawn so it can't interrupt the transition). */
  private busy = false;
  private layout: DashboardLayout;
  /** Last host terminal/tab title we emitted, to dedupe OSC writes across the
   *  frequent (spinner-driven) drawChrome calls. */
  private lastTitle: string | null = null;
  private prevRows: string[] | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parser: InputParser;
  private tornDown = false;
  private resolveDone: (() => void) | null = null;
  private readonly onData = (d: Buffer): void => this.parser.feed(d);
  private readonly onResize = (): void => this.scheduleResize();
  private readonly onSig = (): void => {
    this.teardown();
    process.exit(0);
  };
  private readonly onFatal = (err: unknown): void => {
    this.teardown();
    process.stderr.write(`dashboard: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  };

  constructor(
    private readonly deps: CompositorDeps,
    initialId: string,
  ) {
    this.selectedId = initialId;
    // Initial layout: no alert active yet (maps empty, no question payload),
    // so requestedAlertH is 0; relayout() kicks in once SSE subscriptions
    // populate or the poll fetches a question state.
    this.layout = computeLayout(this.out.columns ?? 100, this.out.rows ?? 30, 0);
    this.parser = new InputParser({
      onEvent: (e) => {
        if (e.type === 'leader') {
          if (this.leaderLingerTimer) {
            clearTimeout(this.leaderLingerTimer);
            this.leaderLingerTimer = null;
          }
          if (e.active) {
            this.leaderActive = true;
          } else {
            // Keep the expanded footer up briefly after the chord resolves.
            this.leaderLingerTimer = setTimeout(() => {
              this.leaderLingerTimer = null;
              this.leaderActive = false;
              this.drawChrome();
            }, LEADER_LINGER_MS);
          }
          this.drawChrome();
          return;
        }
        if (this.pendingConfirm) {
          if (e.type === 'forward') {
            this.handleConfirmKey(e.bytes);
            return;
          }
          // Any non-forward event cancels the confirm, then proceeds normally.
          this.pendingConfirm = null;
          this.drawChrome();
        }
        // Relay prompt for the selected box: intercept y/N/Esc/Ctrl-c
        // single-byte keystrokes. Multi-byte chunks starting with ESC
        // (CSI: mouse, arrows, Ctrl+Option+↑↓, focus events) fall through
        // — they're not user "answer" intent. Same byte-classification as
        // the wrapped-pty input-router so behavior matches.
        if (e.type === 'forward' && this.activePrompts.has(this.selectedId)) {
          if (this.handlePromptKey(e.bytes)) return;
        }
        if (e.type === 'quit') this.onSig();
        else if (e.type === 'switch') this.switchBox(e.dir);
        else if (e.type === 'action') {
          if (e.name === 'pause' || e.name === 'stop' || e.name === 'destroy') {
            void this.doLifecycle(e.name);
          } else {
            void this.doAction(e.name);
          }
        } else if (this.createMenu) this.handleCreateMenuKey(e.bytes);
        else if (this.lifecycleMenu) this.handleLifecycleMenuKey(e.bytes);
        else if (this.menu) this.handleMenuKey(e.bytes);
        else this.session?.write(e.bytes);
      },
      // Absolute 1-based host coords → right-pane-local 1-based; null = the
      // pointer is over the sidebar/status, so Claude shouldn't see it.
      mouseTransform: (x, y) => {
        const r = this.layout.right;
        if (!this.session || this.layout.tooSmall) return null;
        const lx = x - r.x;
        const ly = y - r.y;
        if (lx < 1 || ly < 1 || lx > r.w || ly > r.h) return null;
        return { x: lx, y: ly };
      },
    });
  }

  async run(): Promise<void> {
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J' + MOUSE_ENABLE_SEQ + EXT_KEYS_ENABLE_SEQ);
    // Save the user's tab title so teardown can restore it; updateTitle() (via
    // drawChrome) then drives it to `AgentBox: <selected box>`.
    pushTerminalTitle(this.out);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.on('data', this.onData);
    this.out.on('resize', this.onResize);
    process.once('SIGINT', this.onSig);
    process.once('SIGTERM', this.onSig);
    process.once('uncaughtException', this.onFatal);
    process.once('unhandledRejection', this.onFatal);
    process.once('exit', () => this.teardown());

    await this.refreshBoxes();
    if (!this.boxes.some((b) => b.id === this.selectedId) && this.boxes[0]) {
      this.selectedId = this.boxes[0].id;
    }
    await this.spawnActive();
    this.drawChrome();
    this.scheduleRender();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);

    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private async refreshBoxes(): Promise<void> {
    try {
      this.boxes = await this.deps.listCandidates();
    } catch {
      /* keep last known list */
    }
    this.syncPromptSubscriptions();
    this.reconcileLiveSessions();
  }

  /**
   * Drop pooled (hidden) sessions whose box is gone or no longer running, so a
   * paused/stopped/destroyed box can't keep its remote attach process alive.
   * The *active* session is intentionally skipped — it's torn down on the next
   * switch/re-resolve via {@link deactivateActive} (which checks box state),
   * so evicting it here would blank the pane out from under the poll's
   * re-resolve logic.
   */
  private reconcileLiveSessions(): void {
    for (const boxId of [...this.liveSessions.keys()]) {
      if (this.session && this.session.boxId === boxId) continue;
      const running = this.boxes.some((b) => b.id === boxId && b.state === 'running');
      if (!running) this.evictSession(boxId);
    }
  }

  /**
   * Diff the current box list against {@link promptStreams}: subscribe to
   * any newcomer (skipping the synthetic + New box entry and pre-relay
   * boxes), dispose any departed subscription. Idempotent — safe to call
   * after every poll. Disposed boxes also clear their {@link activePrompts}
   * entry so the sidebar marker doesn't linger.
   */
  private syncPromptSubscriptions(): void {
    if (this.tornDown) return;
    const url = this.deps.relayBaseUrl;
    if (!url) return; // legacy callers: skip the feature entirely.
    const wanted = new Set<string>();
    for (const b of this.boxes) {
      if (b.id === NEW_BOX_ID) continue;
      wanted.add(b.id);
    }
    // Drop subscriptions for boxes no longer in the list.
    for (const [boxId, stream] of this.promptStreams) {
      if (!wanted.has(boxId)) {
        stream.close();
        this.promptStreams.delete(boxId);
        let changed = this.activePrompts.delete(boxId);
        if (this.activeNotices.delete(boxId)) changed = true;
        if (this.activeNotices.size === 0) this.stopNoticeSpinner();
        if (changed) this.redrawForAlert();
      }
    }
    // Open subscriptions for boxes we don't already track.
    for (const boxId of wanted) {
      if (this.promptStreams.has(boxId)) continue;
      const stream = subscribePrompts({
        relayBaseUrl: url,
        boxId,
        onPrompt: (ev) => {
          if (this.tornDown) return;
          this.activePrompts.set(boxId, ev);
          this.redrawForAlert();
        },
        onResolved: (id) => {
          if (this.tornDown) return;
          const current = this.activePrompts.get(boxId);
          if (current && current.id === id) {
            this.activePrompts.delete(boxId);
            this.redrawForAlert();
          }
        },
        onNotice: (ev) => {
          if (this.tornDown) return;
          this.activeNotices.set(boxId, ev);
          this.startNoticeSpinner();
          this.redrawForAlert();
        },
        onNoticeCleared: (id) => {
          if (this.tornDown) return;
          const current = this.activeNotices.get(boxId);
          if (current && current.id === id) {
            this.activeNotices.delete(boxId);
            if (this.activeNotices.size === 0) this.stopNoticeSpinner();
            this.redrawForAlert();
          }
        },
        onError: () => {
          /* subscribePrompts already reconnects with backoff; nothing to do */
        },
      });
      this.promptStreams.set(boxId, stream);
    }
  }

  private startNoticeSpinner(): void {
    if (this.noticeTimer) return;
    this.noticeTimer = setInterval(() => {
      this.noticeFrame++;
      this.drawChrome();
    }, NOTICE_SPINNER_MS);
    if (typeof this.noticeTimer.unref === 'function') this.noticeTimer.unref();
  }

  private stopNoticeSpinner(): void {
    if (this.noticeTimer) {
      clearInterval(this.noticeTimer);
      this.noticeTimer = null;
    }
  }

  private selectedBox(): SidebarBox | undefined {
    return this.boxes.find((b) => b.id === this.selectedId);
  }

  private async poll(): Promise<void> {
    const stateKey = (): string =>
      JSON.stringify(
        this.boxes.map((b) => [b.id, b.state, b.activity, b.sessionTitle]),
      );
    const before = stateKey();
    const beforeAlertH = this.alertHeight();
    await this.refreshBoxes();
    if (this.busy) {
      // A start/shell action is mid-flight — don't yank the right pane.
    } else if (!this.boxes.some((b) => b.id === this.selectedId) && this.boxes[0]) {
      this.selectedId = this.boxes[0].id;
      await this.spawnActive();
    } else {
      // Re-resolve when: an attached box died; a not-running placeholder
      // recovered; or the menu's box stopped. The menu itself is a stable
      // state while its box runs — never respawn it (would reset the screen).
      const box = this.selectedBox();
      const running = box?.state === 'running';
      const reresolve =
        (this.session && !running) ||
        (this.placeholder && running) ||
        (this.menu && !running) ||
        (this.lifecycleMenu != null && box?.state !== this.lifecycleMenu.state);
      if (reresolve) await this.spawnActive();
    }
    const stateChanged = stateKey() !== before;
    const alertChanged = this.alertHeight() !== beforeAlertH;
    if (alertChanged) {
      this.relayout();
    } else if (stateChanged) {
      this.drawChrome();
    }
  }

  /**
   * Detach the active session from view. Keep-alive sessions (those in
   * {@link liveSessions}) stay running in the background; everything else is
   * disposed — matching the pre-pool dispose-on-switch behaviour for docker /
   * hetzner / daytona.
   */
  private deactivateActive(): void {
    const s = this.session;
    if (!s) return;
    s.active = false;
    const pooled = this.liveSessions.get(s.boxId) === s;
    const boxRunning = this.boxes.some((b) => b.id === s.boxId && b.state === 'running');
    // Dispose unless it's a pooled session whose box is still running (then we
    // keep it alive in the background for an instant switch-back). A pooled
    // session whose box stopped/was destroyed is torn down here.
    if (!pooled || !boxRunning) {
      if (pooled) this.liveSessions.delete(s.boxId);
      s.dispose();
    }
    this.session = null;
  }

  /** Dispose and drop the pooled session for `boxId` (box gone / stopped /
   *  its attach died). Clears the active reference if it was the shown one. */
  private evictSession(boxId: string): void {
    const pooled = this.liveSessions.get(boxId);
    if (pooled) {
      this.liveSessions.delete(boxId);
      pooled.dispose();
    }
    if (this.session && this.session.boxId === boxId) {
      // Dispose the active session too — unless it's the pooled one we just
      // disposed (avoid a double dispose). Non-keepAlive sessions
      // (docker/hetzner/daytona) are never in `liveSessions`, so this is the
      // only place their `dispose()` — and its `cleanup` callback, e.g.
      // daytona's `revokeAttachToken` — runs on an unexpected PTY exit.
      if (this.session !== pooled) this.session.dispose();
      this.session = null;
    }
  }

  /** Bound the pool: evict least-recently-used pooled sessions (Map insertion
   *  order) until at most {@link KEEP_ALIVE_MAX} remain, never the active one. */
  private evictLruIfNeeded(): void {
    for (const boxId of this.liveSessions.keys()) {
      if (this.liveSessions.size <= KEEP_ALIVE_MAX) break;
      if (this.session && this.session.boxId === boxId) continue;
      this.evictSession(boxId);
    }
  }

  /** Dispose the active session plus every pooled one (teardown). */
  private disposeAllSessions(): void {
    const active = this.session;
    if (active && this.liveSessions.get(active.boxId) !== active) active.dispose();
    this.session = null;
    for (const s of this.liveSessions.values()) s.dispose();
    this.liveSessions.clear();
  }

  /**
   * Show a pooled session in the right pane — the fast switch-back path: no
   * probe, no re-spawn, instant repaint from its already-current headless
   * buffer. Re-marks it most-recently-used and re-applies the current layout
   * size (it may have changed while hidden).
   */
  private activateSession(sess: PtySession): void {
    this.deactivateActive();
    this.placeholder = null;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.pendingConfirm = null;
    this.session = sess;
    sess.active = true;
    this.activeMode = sess.mode;
    sess.resize(Math.max(1, this.layout.right.w), Math.max(1, this.layout.right.h));
    // Move to the MRU end so the LRU eviction in applyTarget picks idle boxes.
    this.liveSessions.delete(sess.boxId);
    this.liveSessions.set(sess.boxId, sess);
    this.prevRows = null;
    // The shown box may have a different alert-band height than the prior one;
    // reflow if needed (matches applyTarget's tail).
    if (!this.syncAlertLayout()) this.drawChrome();
    this.scheduleRender();
  }

  /**
   * Show the selected box. If a kept-alive session is pooled for it, re-show it
   * synchronously (instant). Otherwise fall through to the async resolve+spawn.
   */
  private showSelected(): void {
    const cached = this.liveSessions.get(this.selectedId);
    if (cached) {
      this.activateSession(cached);
      return;
    }
    void this.spawnActive();
  }

  private async spawnActive(): Promise<void> {
    this.deactivateActive();
    this.placeholder = null;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.pendingConfirm = null;
    // Wipe the old agent now (synchronous, before the async resolve gap) so it
    // can't bleed through while the new attach redraws. Also resets prevRows.
    this.clearRightPane();
    const id = this.selectedId;
    const target = await this.deps.resolveTarget(id);
    if (this.selectedId !== id || this.tornDown) return; // user switched away
    this.applyTarget(target);
  }

  /** Turn a resolved/started target into the right-pane state. */
  private applyTarget(target: RightTarget): void {
    this.deactivateActive();
    this.placeholder = null;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.pendingConfirm = null;
    if (target.kind === 'attach') {
      const boxId = this.selectedId;
      const mode = target.mode ?? 'claude';
      const keepAlive = target.keepAlive ?? false;
      this.activeMode = mode;
      this.session = new PtySession(
        this.deps.ptySpawn,
        this.deps.termCtor,
        boxId,
        keepAlive,
        mode,
        target.command,
        target.args,
        Math.max(1, this.layout.right.w),
        Math.max(1, this.layout.right.h),
        () => this.scheduleRender(),
        (id) => this.onSessionExit(id),
        target.cleanup,
        target.env,
      );
      if (keepAlive) {
        // A re-resolve can replace an existing pooled entry for this box.
        const prev = this.liveSessions.get(boxId);
        if (prev && prev !== this.session) prev.dispose();
        this.liveSessions.set(boxId, this.session);
        this.evictLruIfNeeded();
      }
    } else if (target.kind === 'menu') {
      this.menu = { boxName: this.selectedBox()?.name ?? this.selectedId };
    } else if (target.kind === 'lifecycle-menu') {
      this.lifecycleMenu = {
        boxName: this.selectedBox()?.name ?? this.selectedId,
        state: target.state,
        confirmDestroy: false,
      };
    } else if (target.kind === 'create-menu') {
      this.createMenu = { where: target.where };
    } else {
      this.placeholder = target.lines;
    }
    this.prevRows = null;
    // Selection just changed (spawnActive → applyTarget) — the new box may
    // have a different alert state than the previous one (prompt/notice/
    // question), so reflow if the band height needs to flip.
    if (!this.syncAlertLayout()) this.drawChrome();
    this.scheduleRender();
  }

  private handleMenuKey(bytes: Buffer): void {
    for (const b of bytes) {
      if (b === 0x63 || b === 0x0d || b === 0x0a) {
        void this.chooseAction('claude');
        return;
      }
      if (b === 0x78) {
        void this.chooseAction('codex');
        return;
      }
      if (b === 0x6f) {
        void this.chooseAction('opencode');
        return;
      }
      if (b === 0x73) {
        void this.chooseAction('shell');
        return;
      }
    }
  }

  private async chooseAction(which: 'claude' | 'codex' | 'opencode' | 'shell'): Promise<void> {
    if (this.busy) return;
    const id = this.selectedId;
    const name = this.selectedBox()?.name ?? id;
    this.busy = true;
    this.menu = null;
    this.createMenu = null;
    const label =
      which === 'shell'
        ? 'shell'
        : which === 'opencode'
          ? 'OpenCode'
          : which === 'codex'
            ? 'Codex'
            : 'Claude';
    this.placeholder = ['', which === 'shell' ? '  Opening shell…' : `  Starting ${label}…`];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      const target =
        which === 'shell'
          ? await this.deps.openShell(id)
          : which === 'codex'
            ? await this.deps.startCodex(id)
            : which === 'opencode'
              ? await this.deps.startOpencode(id)
              : await this.deps.startClaude(id);
      if (this.selectedId !== id || this.tornDown) return; // switched away
      this.applyTarget(target);
    } catch (err) {
      if (this.selectedId !== id || this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to ${which === 'shell' ? 'open a shell' : `start ${label}`} in ${name}:`,
        `  ${msg}`,
        '',
        which === 'shell'
          ? `  Try from a shell: agentbox shell ${name}`
          : `  Try from a shell: agentbox ${which} start ${name}`,
      ];
      this.prevRows = null;
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  private handleLifecycleMenuKey(bytes: Buffer): void {
    const m = this.lifecycleMenu;
    if (!m) return;
    for (const b of bytes) {
      if (m.confirmDestroy) {
        if (b === 0x79 || b === 0x0d || b === 0x0a) {
          void this.runDestroy(this.selectedId, this.selectedBox()?.name ?? this.selectedId);
        } else {
          // Any other key cancels the confirm and returns to the menu.
          m.confirmDestroy = false;
          this.drawChrome();
          this.scheduleRender();
        }
        return;
      }
      const resumeKey = m.state === 'paused' ? 0x75 /* u */ : 0x73 /* s */;
      if (b === resumeKey) {
        void this.resumeSelected();
        return;
      }
      if (b === 0x64 /* d */) {
        m.confirmDestroy = true;
        this.drawChrome();
        this.scheduleRender();
        return;
      }
    }
  }

  private async resumeSelected(): Promise<void> {
    if (this.busy) return;
    const id = this.selectedId;
    const name = this.selectedBox()?.name ?? id;
    const verb = this.lifecycleMenu?.state === 'stopped' ? 'start' : 'unpause';
    this.busy = true;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.placeholder = ['', '  Resuming…'];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      await this.deps.resumeBox(id);
      if (this.selectedId !== id || this.tornDown) return; // switched away
      await this.refreshBoxes();
      await this.spawnActive();
    } catch (err) {
      if (this.selectedId !== id || this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to ${verb} ${name}:`,
        `  ${msg}`,
        '',
        `  Try from a shell: agentbox ${verb} ${name}`,
      ];
      this.prevRows = null;
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  /** Destroy `id` and recover the selection. Shared by the lifecycle-menu
   *  confirm and the running-box `Ctrl-a d` status-bar confirm. */
  private async runDestroy(id: string, name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.placeholder = ['', '  Destroying…'];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      await this.deps.destroyBox(id);
      if (this.tornDown) return;
      await this.refreshBoxes();
      // The box is gone from the list; fall back to the first entry (the
      // synthetic "+ New box", always boxes[0] via listCandidates).
      if (this.boxes[0]) this.selectedId = this.boxes[0].id;
      await this.spawnActive();
      this.flash(`destroyed ${name}`);
    } catch (err) {
      if (this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to destroy ${name}:`,
        `  ${msg}`,
        '',
        `  Try from a shell: agentbox destroy ${name}`,
      ];
      this.prevRows = null;
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  /** Ctrl-a p/s/d on the selected box. pause/stop transition state (the pane
   *  re-resolves to the lifecycle menu); destroy asks to confirm first. */
  private async doLifecycle(name: 'pause' | 'stop' | 'destroy'): Promise<void> {
    if (this.selectedId === NEW_BOX_ID) {
      this.flash('select a box first');
      return;
    }
    const id = this.selectedId;
    const boxName = this.selectedBox()?.name ?? id;
    if (name === 'destroy') {
      this.pendingConfirm = { boxId: id, name: boxName };
      this.drawChrome();
      return;
    }
    if (this.selectedBox()?.state !== 'running') {
      this.flash(`${boxName} is not running`);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.placeholder = ['', name === 'pause' ? '  Pausing…' : '  Stopping…'];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      if (name === 'pause') await this.deps.pauseBox(id);
      else await this.deps.stopBox(id);
      if (this.selectedId !== id || this.tornDown) return; // switched away
      await this.refreshBoxes();
      await this.spawnActive();
      this.flash(`${name === 'pause' ? 'paused' : 'stopped'} ${boxName}`);
    } catch (err) {
      if (this.selectedId !== id || this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to ${name} ${boxName}:`,
        `  ${msg}`,
        '',
        `  Try from a shell: agentbox ${name} ${boxName}`,
      ];
      this.prevRows = null;
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Try to consume `bytes` as an answer to the selected box's active relay
   * prompt. Returns true when the bytes were a recognized answer key (the
   * caller stops further dispatch); false when the bytes should flow on to
   * the pty / other handlers.
   *
   * Single-byte chunks only: y/Y/Enter accept, n/N deny, Esc/Ctrl-c deny
   * with `cancelled: true`. Multi-byte chunks starting with ESC (mouse,
   * arrows, focus events, etc.) are passed through — exact same rule the
   * wrapped-pty input-router uses.
   */
  private handlePromptKey(bytes: Buffer): boolean {
    if (bytes.length > 1 && bytes[0] === 0x1b) return false;
    if (bytes.length === 0) return false;
    const b = bytes[0];
    let answer: 'y' | 'n' | null = null;
    let cancelled = false;
    if (b === 0x79 || b === 0x59) answer = 'y'; // 'y'/'Y'
    else if (b === 0x6e || b === 0x4e) answer = 'n'; // 'n'/'N'
    else if (b === 0x1b || b === 0x03) {
      answer = 'n';
      cancelled = true;
    } else if (b === 0x0d || b === 0x0a) {
      // Enter accepts the default; defaultAnswer falls back to 'n' so this
      // matches the [y/N] hint.
      const ev = this.activePrompts.get(this.selectedId);
      answer = ev?.defaultAnswer ?? 'n';
    }
    if (answer === null) return false;
    const ev = this.activePrompts.get(this.selectedId);
    if (!ev) return false;
    // Optimistic local clear so the footer/sidebar update immediately;
    // the relay's prompt-resolved SSE event will arrive afterwards and
    // hit a no-op (already cleared).
    this.activePrompts.delete(this.selectedId);
    this.drawChrome();
    const url = this.deps.relayBaseUrl;
    if (url) {
      void postAnswer({
        relayBaseUrl: url,
        body: { id: ev.id, answer, ...(cancelled ? { cancelled: true } : {}) },
      });
    }
    return true;
  }

  private handleConfirmKey(bytes: Buffer): void {
    const c = this.pendingConfirm;
    if (!c) return;
    const b = bytes[0];
    this.pendingConfirm = null;
    if (b === 0x79 || b === 0x0d || b === 0x0a) {
      void this.runDestroy(c.boxId, c.name);
    } else {
      // Cancelled — restore the footer.
      this.drawChrome();
    }
  }

  private handleCreateMenuKey(bytes: Buffer): void {
    for (const b of bytes) {
      if (b === 0x63 || b === 0x0d || b === 0x0a) {
        void this.chooseCreate('claude');
        return;
      }
      if (b === 0x78) {
        void this.chooseCreate('codex');
        return;
      }
      if (b === 0x6f) {
        void this.chooseCreate('opencode');
        return;
      }
      if (b === 0x6e) {
        void this.chooseCreate(undefined);
        return;
      }
    }
  }

  private async chooseCreate(agent: 'claude' | 'codex' | 'opencode' | undefined): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu = null;
    this.createMenu = null;
    this.placeholder = ['', '  Creating box…', ''];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      const { boxId, attach } = await this.deps.createNewBox(agent, (line) => {
        if (this.tornDown) return;
        this.placeholder = ['', '  Creating box…', '  ' + line];
        this.prevRows = null;
        this.scheduleRender();
      });
      if (this.tornDown) return;
      this.selectedId = boxId;
      await this.refreshBoxes();
      if (attach) {
        this.applyTarget(attach);
      } else {
        await this.spawnActive();
        this.flash('box created');
      }
    } catch (err) {
      if (this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = ['', '  Failed to create box:', `  ${msg}`, '', '  Try from a shell: agentbox create'];
      this.prevRows = null;
      this.drawChrome();
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  private async doAction(name: 'screen' | 'code' | 'url'): Promise<void> {
    if (this.selectedId === NEW_BOX_ID) {
      this.flash('select a box first');
      return;
    }
    const id = this.selectedId;
    let msg: string;
    try {
      msg =
        name === 'screen'
          ? await this.deps.openScreen(id)
          : name === 'code'
            ? await this.deps.openCode(id)
            : await this.deps.openUrl(id);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    this.flash(msg);
  }

  /** Briefly show `msg` in the status row, then revert. */
  private flash(msg: string): void {
    this.flashMsg = msg;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flashMsg = null;
      this.drawChrome();
    }, 2500);
    this.drawChrome();
  }

  private onSessionExit(boxId: string): void {
    // Inner attach ended (container died / tmux session gone). Drop the pooled
    // entry so a switch-back re-resolves instead of showing a dead session.
    this.evictSession(boxId);
    // Only repaint if the box that died is the one on screen — a hidden
    // kept-alive box dying is silent; the next poll reconciles its state.
    if (boxId !== this.selectedId) return;
    this.placeholder = ['', '  session ended — Ctrl-a ↑/↓ to switch boxes'];
    this.prevRows = null;
    this.scheduleRender();
  }

  private switchBox(dir: 'next' | 'prev'): void {
    if (this.boxes.length === 0) return;
    this.pendingConfirm = null;
    const i = Math.max(
      0,
      this.boxes.findIndex((b) => b.id === this.selectedId),
    );
    const n = this.boxes.length;
    const next = dir === 'prev' ? (i - 1 + n) % n : (i + 1) % n;
    this.selectedId = this.boxes[next]!.id;
    this.drawChrome();
    this.showSelected();
  }

  /** Blank the right pane and drop the diff cache (next paint is full). */
  private clearRightPane(): void {
    const r = this.layout.right;
    let s = SYNC_BEGIN + '\x1b[?25l';
    for (let i = 0; i < r.h; i++) {
      s += cursorTo(r.x, r.y + i) + '\x1b[0m' + ' '.repeat(r.w);
    }
    this.out.write(s + SYNC_END);
    this.prevRows = null;
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.tornDown) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, FRAME_MS);
  }

  private render(): void {
    if (this.tornDown) return;
    const r = this.layout.right;
    if (this.layout.tooSmall) {
      this.out.write(cursorTo(0, 0) + '\x1b[2J' + cursorTo(0, 0) + 'terminal too small');
      return;
    }
    if (this.session) {
      const { out, rows } = diffFrame(this.prevRows, this.session.snapshot(), r);
      this.prevRows = rows;
      if (out) this.out.write(SYNC_BEGIN + out + SYNC_END);
    } else if (this.menu) {
      const lines = menuLines(this.menu.boxName, r.w, r.h);
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) s += cursorTo(r.x, r.y + i) + '\x1b[0m' + (lines[i] ?? '');
      this.out.write(s + SYNC_END);
    } else if (this.lifecycleMenu) {
      const lines = lifecycleMenuLines(
        this.lifecycleMenu.boxName,
        this.lifecycleMenu.state,
        this.lifecycleMenu.confirmDestroy,
        r.w,
        r.h,
      );
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) s += cursorTo(r.x, r.y + i) + '\x1b[0m' + (lines[i] ?? '');
      this.out.write(s + SYNC_END);
    } else if (this.createMenu) {
      const lines = createMenuLines(this.createMenu.where, r.w, r.h);
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) s += cursorTo(r.x, r.y + i) + '\x1b[0m' + (lines[i] ?? '');
      this.out.write(s + SYNC_END);
    } else if (this.placeholder) {
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) {
        const line = (this.placeholder[i] ?? '').slice(0, r.w);
        s += cursorTo(r.x, r.y + i) + '\x1b[0m' + line + ' '.repeat(Math.max(0, r.w - line.length));
      }
      this.out.write(s + SYNC_END);
    }
  }

  /** Drive the host terminal/tab title from the selected box:
   *  `AgentBox: <session title | box name>`, or just `AgentBox` for the
   *  synthetic "+ New box" entry / no selection. Deduped via {@link lastTitle}. */
  private updateTitle(): void {
    if (this.tornDown) return;
    const box = this.selectedBox();
    const inner =
      box && box.id !== NEW_BOX_ID
        ? box.state === 'running' && box.sessionTitle
          ? stripTitleGlyph(box.sessionTitle)
          : box.name
        : undefined;
    const title = inner ? `AgentBox: ${inner}` : 'AgentBox';
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    setTerminalTitle(title, this.out);
  }

  private drawChrome(): void {
    this.updateTitle();
    if (this.tornDown || this.layout.tooSmall) return;
    const { sidebar, sepX, statusY } = this.layout;
    // Inject the per-box pendingPrompt / checkpointing flags at render time
    // so sidebarLines' activityCell shows `▲ prompt` / `◆ checkpoint`. We
    // don't mutate this.boxes directly — keeps the polling diff in poll()
    // simple (it compares state/activity/sessionTitle only).
    const decorate = this.activePrompts.size > 0 || this.activeNotices.size > 0;
    const boxesWithPrompt: SidebarBox[] = decorate
      ? this.boxes.map((b) => {
          const pendingPrompt = this.activePrompts.has(b.id);
          const checkpointing = this.activeNotices.has(b.id);
          return pendingPrompt || checkpointing
            ? { ...b, pendingPrompt, checkpointing }
            : b;
        })
      : this.boxes;
    const { lines, rowOwner, headerRows } = sidebarLines(
      boxesWithPrompt,
      this.selectedId,
      sidebar.w,
      sidebar.h,
    );
    let s = SYNC_BEGIN + '\x1b[0m';
    for (let i = 0; i < lines.length; i++) {
      const owner = rowOwner[i] ?? null;
      const isSelected = owner === this.selectedId;
      const hasPrompt = owner !== null && this.activePrompts.has(owner);
      // Lookup the box's activity for `awaiting` styling. We already have
      // `boxesWithPrompt` from the inject pass above (same list passed to
      // sidebarLines), so just match on owner.
      const ownerBox = owner !== null ? boxesWithPrompt.find((b) => b.id === owner) : undefined;
      const isAwaiting = ownerBox?.activity === 'waiting';
      // Priority: header > selected > pending prompt > awaiting input > body.
      // Selected wins over both attention states because the status-line
      // already shows what the selected box needs; double-yelling would
      // just clutter. Pending prompt outranks awaiting because it's a
      // hard block (the agent's RPC is paused) vs. a soft "I'm idle".
      const style = headerRows[i]
        ? SB_HEADER
        : isSelected
          ? SB_SELECTED
          : hasPrompt
            ? SB_PROMPT
            : isAwaiting
              ? SB_AWAITING
              : SB_BODY;
      s += cursorTo(0, i) + style + lines[i] + SGR_RESET;
    }
    // Rounded top-right corner connecting the sidebar's top border to the
    // right separator; plain `│` below (no bottom corner — saves a row).
    // Blue (SB_HEADER) so the whole right border matches the rounded header.
    for (let y = 0; y < sidebar.h; y++)
      s += cursorTo(sepX, y) + SB_HEADER + (y === 0 ? '╮' : '│') + SGR_RESET;
    // Alert band: 3-line surface above the footer for the selected box's
    // active relay prompt, notice (checkpoint), or claude AskUserQuestion.
    // Painted only when `layout.alertH > 0`, which already gates on min size.
    // Priority matches the wrapped-pty band: prompt > notice > question.
    const activePromptForSelected = this.activePrompts.get(this.selectedId);
    const activeNoticeForSelected = this.activeNotices.get(this.selectedId);
    if (this.layout.alertH > 0) {
      const bandRows = this.layout.alertH;
      let bandLines: string[] | null = null;
      if (activePromptForSelected) {
        bandLines = renderAlertBand(
          { kind: 'prompt', prompt: activePromptForSelected },
          this.layout.cols,
          bandRows,
        );
      } else if (activeNoticeForSelected) {
        bandLines = renderAlertBand(
          { kind: 'notice', message: activeNoticeForSelected.message, frame: this.noticeFrame },
          this.layout.cols,
          bandRows,
        );
      } else {
        const q = this.selectedBox()?.claudeQuestion;
        if (q) {
          bandLines = renderAlertBand({ kind: 'question', question: q }, this.layout.cols, bandRows);
        }
      }
      if (bandLines) {
        for (let i = 0; i < bandLines.length; i++) {
          s += cursorTo(0, this.layout.alertY + i) + bandLines[i] + SGR_RESET;
        }
      }
    }

    // Footer (statusY row): stays at idle / pendingConfirm / flashMsg even when
    // the band is showing prompt/notice/question above — keeps the calm status
    // bar in place. Min-size fallback: when alertH was dropped to 0 by the
    // layout but the selected box has an alert, surface the legacy
    // prompt/notice replacement so a tiny terminal still shows the alert.
    let status: string;
    if (this.pendingConfirm) {
      const w = this.layout.cols;
      const txt = ` Destroy ${this.pendingConfirm.name}?  y = confirm  ·  any other key = cancel `
        .slice(0, w)
        .padEnd(w);
      status = `\x1b[7m${txt}\x1b[0m`;
    } else if (this.flashMsg) {
      const w = this.layout.cols;
      const txt = ` ${this.flashMsg} `.slice(0, w).padEnd(w);
      status = `\x1b[7m${txt}\x1b[0m`;
    } else if (this.layout.alertH === 0 && activePromptForSelected) {
      status = renderFooter(
        { kind: 'prompt', prompt: activePromptForSelected },
        this.layout.cols,
      );
    } else if (this.layout.alertH === 0 && activeNoticeForSelected) {
      status = renderFooter(
        { kind: 'notice', message: activeNoticeForSelected.message, frame: this.noticeFrame },
        this.layout.cols,
      );
    } else {
      const stateLabel =
        this.selectedId === NEW_BOX_ID
          ? 'create'
          : this.menu
            ? 'menu'
            : // Attached to a non-claude session → label it (shell/codex/
              // opencode); claude → undefined so claude activity shows.
              this.session && this.activeMode !== 'claude'
              ? this.activeMode
              : undefined;
      status = statusLine(
        this.selectedBox(),
        this.layout.cols,
        stateLabel,
        this.leaderActive ? ADVANCED_HINT_GROUPS : undefined,
      );
    }
    s += cursorTo(0, statusY) + status;
    this.out.write(s + SYNC_END);
  }

  private scheduleResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.relayout();
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Requested band height for the currently-selected box. Returns
   * `ALERT_BAND_ROWS` when the box has an active relay prompt, an active
   * notice (checkpoint), or claude is in the `question` state with a payload;
   * 0 otherwise. The layout silently drops the band to 0 if reserving it
   * would push the right pane below MIN_RIGHT_H.
   */
  private alertHeight(): number {
    const id = this.selectedId;
    if (this.activePrompts.has(id)) return ALERT_BAND_ROWS;
    if (this.activeNotices.has(id)) return ALERT_BAND_ROWS;
    const box = this.selectedBox();
    if (box?.claudeQuestion) return ALERT_BAND_ROWS;
    return 0;
  }

  /**
   * Recompute the layout against the current alert height, resize the inner
   * session, and repaint. Called from `scheduleResize` (terminal resize) and
   * from {@link syncAlertLayout} when the selected box's alert state flips.
   */
  private relayout(): void {
    this.layout = computeLayout(
      this.out.columns ?? 100,
      this.out.rows ?? 30,
      this.alertHeight(),
    );
    this.prevRows = null;
    const r = this.layout.right;
    if (this.session && !this.layout.tooSmall) {
      this.session.resize(Math.max(1, r.w), Math.max(1, r.h));
    }
    this.out.write(SYNC_BEGIN + '\x1b[2J' + SYNC_END);
    this.drawChrome();
    this.render();
  }

  /**
   * If the selected box's alert state implies a different band height than
   * the current layout, run a full {@link relayout}; otherwise return false
   * so the caller can take the lighter `drawChrome()` path. Used by all
   * alert-state transitions (SSE handlers, poll, selection change).
   */
  private syncAlertLayout(): boolean {
    if (this.alertHeight() !== this.layout.alertH) {
      this.relayout();
      return true;
    }
    return false;
  }

  /** Common path for alert-state transitions: relayout when the band's
   *  visibility changes, drawChrome only when it doesn't. */
  private redrawForAlert(): void {
    if (!this.syncAlertLayout()) this.drawChrome();
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.leaderLingerTimer) clearTimeout(this.leaderLingerTimer);
    if (this.noticeTimer) clearInterval(this.noticeTimer);
    for (const stream of this.promptStreams.values()) stream.close();
    this.promptStreams.clear();
    this.activePrompts.clear();
    this.activeNotices.clear();
    this.parser.dispose();
    this.disposeAllSessions();
    this.inp.off('data', this.onData);
    this.out.off('resize', this.onResize);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    // Belt-and-suspenders: clear the whole mouse-mode family in case Claude
    // enabled one we didn't individually track.
    this.out.write(EXT_KEYS_DISABLE_SEQ + MOUSE_DISABLE_SEQ + '\x1b[?25h\x1b[0m\x1b[?1049l');
    // Restore the host terminal/tab title saved in run().
    popTerminalTitle(this.out);
    this.resolveDone?.();
  }
}
