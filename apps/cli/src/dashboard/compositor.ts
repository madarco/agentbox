import { computeLayout, type DashboardLayout } from './layout.js';
import { diffFrame } from './renderer.js';
import { InputParser } from './input.js';
import {
  PtySession,
  MOUSE_ENABLE_SEQ,
  MOUSE_DISABLE_SEQ,
  type PtySpawn,
  type TerminalCtor,
} from './pty-session.js';
import {
  sidebarLines,
  statusLine,
  menuLines,
  lifecycleMenuLines,
  createMenuLines,
  NEW_BOX_ID,
  ADVANCED_HINT_GROUPS,
  BAR_BG,
  type SidebarBox,
} from './sidebar.js';

// Sidebar panel styling (256-color, portable). Each sidebar line is already
// padded to the panel width, so wrapping it in a bg SGR tints the full column.
// Background is the footer gray (`BAR_BG`) everywhere — uniform with the status
// bar; the selected row reads via bold bright-white text + the `▸` marker.
const SB_BODY = BAR_BG + '\x1b[38;5;250m';
const SB_HEADER = BAR_BG + '\x1b[38;5;39m\x1b[1m';
const SB_SELECTED = BAR_BG + '\x1b[38;5;255m\x1b[1m';
const SGR_RESET = '\x1b[0m';

export type RightTarget =
  | { kind: 'attach'; argv: string[]; mode?: 'claude' | 'shell' }
  | { kind: 'menu' }
  | { kind: 'lifecycle-menu'; state: 'paused' | 'stopped' }
  | { kind: 'create-menu'; where: string }
  | { kind: 'placeholder'; lines: string[] };

export interface CompositorDeps {
  ptySpawn: PtySpawn;
  termCtor: TerminalCtor;
  /** Scoped + sorted candidate boxes (same order the sidebar renders). */
  listCandidates: () => Promise<SidebarBox[]>;
  /** What the right pane should show for a box (attach argv / menu / message). */
  resolveTarget: (boxId: string) => Promise<RightTarget>;
  /** Start a proper Claude tmux session in the box, then resolve to attach. */
  startClaude: (boxId: string) => Promise<RightTarget>;
  /** Open an interactive shell in the box, resolve to attach. */
  openShell: (boxId: string) => Promise<RightTarget>;
  /** Create a new box (config defaults). With Claude: also start + return an
   *  attach target. `onProgress` streams createBox log lines. */
  createNewBox: (
    withClaude: boolean,
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
  openVnc: (boxId: string) => Promise<string>;
  openCode: (boxId: string) => Promise<string>;
  openWeb: (boxId: string) => Promise<string>;
}

const POLL_MS = 1000;
const FRAME_MS = 16;
const RESIZE_DEBOUNCE_MS = 120;
/** Keep the expanded chord footer visible this long after the Ctrl-a leader
 *  resolves, so it's actually readable instead of flashing by. */
const LEADER_LINGER_MS = 1500;

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
  private session: PtySession | null = null;
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
  private activeMode: 'claude' | 'shell' = 'claude';
  private flashMsg: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a start-Claude / open-shell action is in flight (suppresses
   * the poll respawn so it can't interrupt the transition). */
  private busy = false;
  private layout: DashboardLayout;
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
    this.layout = computeLayout(this.out.columns ?? 100, this.out.rows ?? 30);
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
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J' + MOUSE_ENABLE_SEQ);
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
  }

  private selectedBox(): SidebarBox | undefined {
    return this.boxes.find((b) => b.id === this.selectedId);
  }

  private async poll(): Promise<void> {
    const before = JSON.stringify(
      this.boxes.map((b) => [b.id, b.state, b.claudeActivity, b.sessionTitle]),
    );
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
    if (
      JSON.stringify(
        this.boxes.map((b) => [b.id, b.state, b.claudeActivity, b.sessionTitle]),
      ) !== before
    ) {
      this.drawChrome();
    }
  }

  private disposeSession(): void {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
  }

  private async spawnActive(): Promise<void> {
    this.disposeSession();
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
    this.disposeSession();
    this.placeholder = null;
    this.menu = null;
    this.lifecycleMenu = null;
    this.createMenu = null;
    this.pendingConfirm = null;
    if (target.kind === 'attach') {
      this.activeMode = target.mode ?? 'claude';
      this.session = new PtySession(
        this.deps.ptySpawn,
        this.deps.termCtor,
        target.argv,
        Math.max(1, this.layout.right.w),
        Math.max(1, this.layout.right.h),
        () => this.scheduleRender(),
        () => this.onSessionExit(),
      );
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
    this.drawChrome();
    this.scheduleRender();
  }

  private handleMenuKey(bytes: Buffer): void {
    for (const b of bytes) {
      if (b === 0x63 || b === 0x0d || b === 0x0a) {
        void this.chooseAction('claude');
        return;
      }
      if (b === 0x73) {
        void this.chooseAction('shell');
        return;
      }
    }
  }

  private async chooseAction(which: 'claude' | 'shell'): Promise<void> {
    if (this.busy) return;
    const id = this.selectedId;
    const name = this.selectedBox()?.name ?? id;
    this.busy = true;
    this.menu = null;
    this.createMenu = null;
    this.placeholder = ['', which === 'claude' ? '  Starting Claude…' : '  Opening shell…'];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      const target =
        which === 'claude'
          ? await this.deps.startClaude(id)
          : await this.deps.openShell(id);
      if (this.selectedId !== id || this.tornDown) return; // switched away
      this.applyTarget(target);
    } catch (err) {
      if (this.selectedId !== id || this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to ${which === 'claude' ? 'start Claude' : 'open a shell'} in ${name}:`,
        `  ${msg}`,
        '',
        which === 'claude'
          ? `  Try from a shell: agentbox claude start ${name}`
          : `  Try from a shell: agentbox shell ${name}`,
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
        void this.chooseCreate(true);
        return;
      }
      if (b === 0x6e) {
        void this.chooseCreate(false);
        return;
      }
    }
  }

  private async chooseCreate(withClaude: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu = null;
    this.createMenu = null;
    this.placeholder = ['', '  Creating box…', ''];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      const { boxId, attach } = await this.deps.createNewBox(withClaude, (line) => {
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

  private async doAction(name: 'vnc' | 'code' | 'web'): Promise<void> {
    if (this.selectedId === NEW_BOX_ID) {
      this.flash('select a box first');
      return;
    }
    const id = this.selectedId;
    let msg: string;
    try {
      msg =
        name === 'vnc'
          ? await this.deps.openVnc(id)
          : name === 'code'
            ? await this.deps.openCode(id)
            : await this.deps.openWeb(id);
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

  private onSessionExit(): void {
    // Inner attach ended (container died / tmux session gone). Show a message;
    // the next poll reconciles box state.
    this.disposeSession();
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
    void this.spawnActive();
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

  private drawChrome(): void {
    if (this.tornDown || this.layout.tooSmall) return;
    const { sidebar, sepX, statusY } = this.layout;
    const { lines, rowOwner, headerRows } = sidebarLines(
      this.boxes,
      this.selectedId,
      sidebar.w,
      sidebar.h,
    );
    let s = SYNC_BEGIN + '\x1b[0m';
    for (let i = 0; i < lines.length; i++) {
      const style = headerRows[i]
        ? SB_HEADER
        : rowOwner[i] === this.selectedId
          ? SB_SELECTED
          : SB_BODY;
      s += cursorTo(0, i) + style + lines[i] + SGR_RESET;
    }
    // Rounded top-right corner connecting the sidebar's top border to the
    // right separator; plain `│` below (no bottom corner — saves a row).
    // Blue (SB_HEADER) so the whole right border matches the rounded header.
    for (let y = 0; y < sidebar.h; y++)
      s += cursorTo(sepX, y) + SB_HEADER + (y === 0 ? '╮' : '│') + SGR_RESET;
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
    } else {
      const stateLabel =
        this.selectedId === NEW_BOX_ID
          ? 'create'
          : this.menu
            ? 'menu'
            : this.session && this.activeMode === 'shell'
              ? 'shell'
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
      this.layout = computeLayout(this.out.columns ?? 100, this.out.rows ?? 30);
      this.prevRows = null;
      const r = this.layout.right;
      if (this.session && !this.layout.tooSmall) {
        this.session.resize(Math.max(1, r.w), Math.max(1, r.h));
      }
      this.out.write(SYNC_BEGIN + '\x1b[2J' + SYNC_END);
      this.drawChrome();
      this.render();
    }, RESIZE_DEBOUNCE_MS);
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.leaderLingerTimer) clearTimeout(this.leaderLingerTimer);
    this.parser.dispose();
    this.disposeSession();
    this.inp.off('data', this.onData);
    this.out.off('resize', this.onResize);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    // Belt-and-suspenders: clear the whole mouse-mode family in case Claude
    // enabled one we didn't individually track.
    this.out.write(MOUSE_DISABLE_SEQ + '\x1b[?25h\x1b[0m\x1b[?1049l');
    this.resolveDone?.();
  }
}
