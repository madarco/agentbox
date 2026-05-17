import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { findProjectRoot } from '@agentbox/config';
import {
  buildClaudeAttachArgv,
  claudeSessionInfo,
  listBoxes,
  type ListedBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DashboardOptions {
  all?: boolean;
  /** Internal: run as the left-pane sidebar renderer; value is the tmux session/socket. */
  sidebar?: string;
  /** Internal: switch the selected box; value is 'next' | 'prev'. Needs --session. */
  switch?: string;
  /** Internal: outer tmux session + socket label (for --switch). */
  session?: string;
}

const SEL_OPT = '@agentbox_sel';
const ALL_OPT = '@agentbox_all';
const PROJECT_OPT = '@agentbox_project';
const RIGHT_PANE_OPT = '@agentbox_right_pane';
const SIDEBAR_COLS = 32;

/** POSIX single-quote so a path with spaces survives tmux's `sh -c`. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** tmux treats `#` in status strings as a format introducer — double it. */
function statusEscape(s: string): string {
  return s.replace(/#/g, '##');
}

function tmuxArgs(session: string, args: string[]): string[] {
  return ['-L', session, ...args];
}

/** tmux calls are sub-millisecond; spawnSync keeps control flow simple and
 * avoids pulling execa into apps/cli (it shells out via @agentbox/* instead). */
function tmux(session: string, args: string[]): string {
  const r = spawnSync('tmux', tmuxArgs(session, args), { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

function getOpt(session: string, name: string): string {
  return tmux(session, ['show-options', '-v', '-t', session, name]);
}

function setOpt(session: string, name: string, value: string): void {
  tmux(session, ['set-option', '-t', session, name, value]);
}

const NODE = process.execPath;
const ENTRY = process.argv[1] ?? '';

/** Same ordering the sidebar renders and the switch action steps through. */
function sortBoxes(boxes: ListedBox[]): ListedBox[] {
  return [...boxes].sort((a, b) => {
    const ai = a.projectIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.projectIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

/** Resolve the candidate box set from the session-stored scope (no cwd needed). */
async function candidateBoxes(session: string): Promise<ListedBox[]> {
  const all = getOpt(session, ALL_OPT) === '1';
  const project = getOpt(session, PROJECT_OPT);
  const boxes = await listBoxes();
  const scoped = all ? boxes : boxes.filter((b) => b.projectRoot === project);
  return sortBoxes(scoped);
}

function activityCell(b: ListedBox): string {
  if (b.state !== 'running') return `[${b.state}]`;
  switch (b.claudeActivity) {
    case 'working':
      return '● working';
    case 'idle':
      return '○ idle';
    case 'waiting':
      return '◐ waiting';
    default:
      return '? unknown';
  }
}

// --- right pane -----------------------------------------------------------

function placeholderScript(message: string): string {
  return `printf '%s\\n\\nCtrl-Up / Ctrl-Down to switch boxes\\n' ${shq(message)}; exec sleep 86400`;
}

async function repointRightPane(
  session: string,
  paneId: string,
  box: ListedBox,
): Promise<void> {
  let script: string;
  if (box.state !== 'running') {
    script = placeholderScript(
      `box ${box.name} is ${box.state}. Start it with: agentbox start ${box.name}`,
    );
  } else {
    const info = await claudeSessionInfo(box.container);
    if (info.running) {
      const dockerCmd = ['docker', ...buildClaudeAttachArgv(box.container, info.sessionName)]
        .map(shq)
        .join(' ');
      // Wrap so a dead container / ended attach leaves a message instead of
      // collapsing the pane (which would re-tile the dashboard layout).
      script = `${dockerCmd}; printf '\\nsession ended — Ctrl-Up / Ctrl-Down to switch\\n'; exec sleep 86400`;
    } else {
      script = placeholderScript(
        `no Claude session in ${box.name}. Start one with: agentbox claude start ${box.name}`,
      );
    }
  }
  tmux(session, ['respawn-pane', '-k', '-t', paneId, script]);
  tmux(session, ['select-pane', '-t', paneId]);
}

function renderStatusLine(session: string, box: ListedBox): void {
  const left = ` agentbox ▸ ${box.name} (${box.state === 'running' ? (box.claudeActivity ?? 'unknown') : box.state}) `;
  const right = ' ^⌥↑/↓ (or Ctrl-a ↑/↓) switch · Ctrl-a d detach · Ctrl-a q quit ';
  setOpt(session, 'status-left', statusEscape(left));
  setOpt(session, 'status-right', statusEscape(right));
}

// --- modes ----------------------------------------------------------------

async function runSidebar(session: string): Promise<never> {
  process.stdout.write('\x1b[?25l');
  process.once('exit', () => process.stdout.write('\x1b[?25h'));
  const sleep = (d: number): Promise<void> => new Promise((r) => setTimeout(r, d));
  for (;;) {
    let body: string;
    try {
      const boxes = await candidateBoxes(session);
      const sel = getOpt(session, SEL_OPT);
      const nameW = Math.min(
        18,
        Math.max(6, ...boxes.map((b) => b.name.length)),
      );
      body = boxes
        .map((b) => {
          const marker = b.id === sel ? '▸ ' : '  ';
          return `${marker}${b.name.slice(0, nameW).padEnd(nameW)}  ${activityCell(b)}`;
        })
        .join('\n');
      if (boxes.length === 0) body = '(no boxes)';
    } catch (err) {
      body = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    process.stdout.write(`\x1b[H\x1b[2J BOXES\n\n${body}\n`);
    await sleep(1000);
  }
}

async function runSwitch(session: string, dir: string): Promise<void> {
  try {
    const boxes = await candidateBoxes(session);
    if (boxes.length === 0) return;
    const sel = getOpt(session, SEL_OPT);
    const cur = boxes.findIndex((b) => b.id === sel);
    const i = cur < 0 ? 0 : cur;
    const n = boxes.length;
    const nextIdx = dir === 'prev' ? (i - 1 + n) % n : (i + 1) % n;
    const target = boxes[nextIdx]!;
    const rightPane = getOpt(session, RIGHT_PANE_OPT);
    if (rightPane) await repointRightPane(session, rightPane, target);
    setOpt(session, SEL_OPT, target.id);
    renderStatusLine(session, target);
  } catch {
    // Never crash the key binding.
  }
}

async function runLauncher(
  idOrName: string | undefined,
  opts: DashboardOptions,
): Promise<void> {
  if (!process.stdout.isTTY) {
    log.error('agentbox dashboard needs an interactive terminal');
    process.exit(2);
  }
  const tmuxVersion = spawnSync('tmux', ['-V']);
  if (tmuxVersion.status !== 0) {
    log.error('tmux is required on the host for the dashboard');
    log.info('install it (e.g. `brew install tmux`) and retry');
    process.exit(2);
  }

  const project = await findProjectRoot(process.cwd());
  const all = Boolean(opts.all);
  const boxes = await listBoxes();
  const scoped = sortBoxes(
    all ? boxes : boxes.filter((b) => b.projectRoot === project.root),
  );
  if (scoped.length === 0) {
    log.error(all ? 'no boxes exist' : `no boxes in this project (${project.root})`);
    log.info('run `agentbox create` to make one');
    process.exit(2);
  }

  let initial: ListedBox;
  if (idOrName !== undefined) {
    const picked = await resolveBoxOrExit(idOrName);
    // Prefer the scoped entry; fall back to the full list so a cross-project
    // explicit ref keeps its real state instead of a synthetic one.
    initial =
      scoped.find((b) => b.id === picked.id) ??
      boxes.find((b) => b.id === picked.id) ??
      scoped[0]!;
  } else {
    initial = scoped.find((b) => b.state === 'running') ?? scoped[0]!;
  }

  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 32;
  if (cols < 80 || rows < 20) {
    log.warn('terminal is small; the dashboard works best at >=100x24');
  }

  const S = `agentbox-dash-${process.pid}`;
  const teardown = (): void => {
    spawnSync('tmux', tmuxArgs(S, ['kill-server']), { stdio: 'ignore' });
  };
  process.once('exit', teardown);
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  // Start fresh in case a same-pid private server leaked from a prior run.
  tmux(S, ['kill-server']);

  const sidebarCmd = `${shq(NODE)} ${shq(ENTRY)} dashboard --sidebar ${shq(S)}`;
  spawnSync('tmux', tmuxArgs(S, [
    'new-session', '-d', '-s', S, '-x', String(cols), '-y', String(rows),
    '-n', 'agentbox', sidebarCmd,
  ]));

  setOpt(S, SEL_OPT, initial.id);
  setOpt(S, ALL_OPT, all ? '1' : '0');
  setOpt(S, PROJECT_OPT, project.root);

  const rightPane = tmux(S, [
    'split-window', '-h', '-t', `${S}:agentbox`, '-P', '-F', '#{pane_id}',
    placeholderScript('starting…'),
  ]);
  setOpt(S, RIGHT_PANE_OPT, rightPane);
  tmux(S, ['resize-pane', '-t', `${S}:agentbox.0`, '-x', String(SIDEBAR_COLS)]);

  // Status line as the global footer (visible from either pane).
  setOpt(S, 'status', 'on');
  setOpt(S, 'status-position', 'bottom');
  setOpt(S, 'status-left-length', '70');
  setOpt(S, 'status-right-length', '70');
  renderStatusLine(S, initial);

  // Best-effort: let the terminal deliver Ctrl+Option+arrow as a distinct
  // modified key (CSI 1;7 A). Harmless / ignored on tmux versions without it.
  setOpt(S, 'extended-keys', 'on');

  const sw = (dir: string): string =>
    `${shq(NODE)} ${shq(ENTRY)} dashboard --switch ${dir} --session ${shq(S)}`;

  // Primary: Ctrl+Option+Up/Down in the ROOT table so they fire regardless of
  // focused pane. macOS reserves Ctrl+arrow for Mission Control / Exposé, but
  // NOT Ctrl+Option+arrow, so the OS leaves these for us. tmux name C-M-Up.
  tmux(S, ['bind-key', '-n', 'C-M-Up', 'run-shell', sw('prev')]);
  tmux(S, ['bind-key', '-n', 'C-M-Down', 'run-shell', sw('next')]);

  // Remap outer prefix to C-a so plain Ctrl-b passes through to the inner box
  // tmux/Claude; Ctrl-a d detaches, Ctrl-a q tears the dashboard down.
  setOpt(S, 'prefix', 'C-a');
  tmux(S, ['bind-key', 'C-a', 'send-prefix']);
  tmux(S, ['bind-key', 'q', 'kill-server']);

  // Bulletproof fallback: prefix chords always work, even on terminals that
  // don't emit the extended C-M-arrow sequence (e.g. stock Terminal.app).
  tmux(S, ['bind-key', 'Up', 'run-shell', sw('prev')]);
  tmux(S, ['bind-key', 'Down', 'run-shell', sw('next')]);
  tmux(S, ['bind-key', 'p', 'run-shell', sw('prev')]);
  tmux(S, ['bind-key', 'n', 'run-shell', sw('next')]);

  await repointRightPane(S, rightPane, initial);

  if (process.env['TMUX']) {
    log.info('inside tmux: this dashboard uses its own server; prefix is Ctrl-a');
  }

  const child = spawnSync('tmux', tmuxArgs(S, ['attach-session', '-t', S]), {
    stdio: 'inherit',
  });
  teardown();
  process.exit(child.status ?? 0);
}

export const dashboardCommand = new Command('dashboard')
  .description(
    'Split-screen TUI: box list + the selected box live Claude session (Ctrl-Up/Down to switch)',
  )
  .argument(
    '[box]',
    'initial box (default: first running box in this project; --all for every project box)',
  )
  .option('-a, --all', "include every box in the cwd's project")
  .option('--sidebar <session>')
  .option('--switch <dir>')
  .option('--session <name>')
  .action(async (idOrName: string | undefined, opts: DashboardOptions) => {
    try {
      if (opts.sidebar) {
        await runSidebar(opts.sidebar);
        return;
      }
      if (opts.switch) {
        await runSwitch(opts.session ?? '', opts.switch);
        return;
      }
      await runLauncher(idOrName, opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

for (const o of dashboardCommand.options) {
  if (o.long === '--sidebar' || o.long === '--switch' || o.long === '--session') {
    o.hidden = true;
  }
}
