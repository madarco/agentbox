import { log } from '@clack/prompts';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { parseKeysList } from '../lib/drive/keys.js';
import { resolveDriveSession, SessionNotFoundError } from '../lib/drive/session.js';
import {
  captureSession,
  paneInfo,
  resizeWindow,
  sendKey,
  sendLiteral,
  type CaptureOptions,
} from '../lib/drive/tmux.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

// Default settle delay before `drive prompt` sends its trailing Enter. Some
// agent TUIs debounce stdin for a few frames after first input lands; without
// the gap the Enter fires before the text is composed and gets swallowed.
const PROMPT_ENTER_DELAY_MS = 200;

const POLL_INTERVAL_MS = 250;

export const driveCommand = new Command('drive').description(
  'Drive a running tmux session inside a box: snapshot the screen, send keystrokes, type text, or wait for output. Targets the agent session by default (claude → codex → opencode).',
);

const sessionOption = [
  '--session <name>',
  'tmux session to target (default: first running agent session)',
] as const;

interface SnapshotOpts {
  session?: string;
  ansi?: boolean;
  withCursor?: boolean;
  rows?: string;
  json?: boolean;
}

const driveSnapshotCommand = new Command('snapshot')
  .description("Print the rendered terminal contents of the box's active tmux session.")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option(sessionOption[0], sessionOption[1])
  .option('--ansi', 'preserve ANSI color/style escape sequences (default: plain text)')
  .option('--with-cursor', 'include cursor coordinates and pane size (implies --json)')
  .option('--rows <range>', 'inclusive row range "FROM:TO" (negative numbers walk into scrollback)')
  .option('--json', 'emit a JSON envelope { session, cols, rows, cursor?, screen }')
  .action(async (boxRef: string | undefined, opts: SnapshotOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);

      const captureOpts: CaptureOptions = {};
      if (opts.ansi) captureOpts.ansi = true;
      if (opts.rows !== undefined) captureOpts.rows = parseRowRange(opts.rows);

      const screen = await captureSession(provider, box, session.name, captureOpts);

      const wantJson = opts.json === true || opts.withCursor === true;
      if (!wantJson) {
        process.stdout.write(screen + '\n');
        return;
      }
      const envelope: {
        session: string;
        screen: string;
        cols?: number;
        rows?: number;
        cursor?: { x: number; y: number };
      } = { session: session.name, screen };
      if (opts.withCursor) {
        const info = await paneInfo(provider, box, session.name);
        envelope.cols = info.cols;
        envelope.rows = info.rows;
        envelope.cursor = info.cursor;
      }
      process.stdout.write(JSON.stringify(envelope) + '\n');
    } catch (err) {
      handleDriveError(err);
    }
  });

interface SessionOpts {
  session?: string;
}

const driveKeypressCommand = new Command('keypress')
  .description(
    'Send keystrokes parsed via the DSL (e.g. "<C-a>q", "ls<Enter>"). Each arg is concatenated with no spaces.',
  )
  .argument('<box>', 'box ref: project index, id, id prefix, name, or container')
  .argument('<keys...>', 'one or more DSL tokens / literal text; `<<` escapes a literal `<`')
  .option(sessionOption[0], sessionOption[1])
  .action(async (boxRef: string, keys: string[], opts: SessionOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);
      const literal = parseKeysList(keys);
      await sendLiteral(provider, box, session.name, literal);
    } catch (err) {
      handleDriveError(err);
    }
  });

const driveSendTextCommand = new Command('send-text')
  .description('Type literal text into the session (no DSL parsing, no trailing Enter).')
  .argument('<box>', 'box ref')
  .argument('<text>', 'literal text to type')
  .option(sessionOption[0], sessionOption[1])
  .action(async (boxRef: string, text: string, opts: SessionOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);
      await sendLiteral(provider, box, session.name, text);
    } catch (err) {
      handleDriveError(err);
    }
  });

interface PromptOpts extends SessionOpts {
  delay?: string;
}

const drivePromptCommand = new Command('prompt')
  .description(
    'Type text into the agent session and press Enter — convenience for "send a message to the running agent".',
  )
  .argument('<box>', 'box ref')
  .argument('<text>', 'prompt text to send (literal; no DSL parsing)')
  .option(sessionOption[0], sessionOption[1])
  .option(
    '--delay <ms>',
    `milliseconds to wait between text and Enter (default: ${String(PROMPT_ENTER_DELAY_MS)})`,
  )
  .action(async (boxRef: string, text: string, opts: PromptOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);
      const delay =
        opts.delay !== undefined ? parsePositiveInt(opts.delay, '--delay') : PROMPT_ENTER_DELAY_MS;
      await sendLiteral(provider, box, session.name, text);
      if (delay > 0) await sleep(delay);
      await sendKey(provider, box, session.name, 'Enter');
    } catch (err) {
      handleDriveError(err);
    }
  });

interface WaitOpts extends SessionOpts {
  text: string;
  timeout?: string;
  json?: boolean;
}

const driveWaitCommand = new Command('wait')
  .description(
    "Block until --text appears in the session's rendered screen, or exit non-zero on timeout.",
  )
  .argument('<box>', 'box ref')
  .requiredOption('--text <str>', 'substring to wait for')
  .option('--timeout <ms>', 'wall-clock cap in milliseconds (default: 5000)')
  .option(sessionOption[0], sessionOption[1])
  .option('--json', 'emit a JSON envelope { matched, elapsedMs, session, screen? }')
  .action(async (boxRef: string, opts: WaitOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);
      const timeoutMs =
        opts.timeout !== undefined ? parsePositiveInt(opts.timeout, '--timeout') : 5000;
      const start = Date.now();
      const deadline = start + timeoutMs;
      let lastScreen = '';
      while (Date.now() < deadline) {
        lastScreen = await captureSession(provider, box, session.name);
        if (lastScreen.includes(opts.text)) {
          const elapsedMs = Date.now() - start;
          if (opts.json === true) {
            process.stdout.write(
              JSON.stringify({ matched: true, elapsedMs, session: session.name }) + '\n',
            );
          }
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      const elapsedMs = Date.now() - start;
      if (opts.json === true) {
        process.stdout.write(
          JSON.stringify({
            matched: false,
            elapsedMs,
            session: session.name,
            screen: lastScreen,
          }) + '\n',
        );
      } else {
        log.error(`text not found within ${String(timeoutMs)}ms: ${opts.text}`);
      }
      process.exit(1);
    } catch (err) {
      handleDriveError(err);
    }
  });

const driveResizeCommand = new Command('resize')
  .description('Resize the tmux window to <cols> x <rows>.')
  .argument('<box>', 'box ref')
  .argument('<cols>', 'columns (positive int)')
  .argument('<rows>', 'rows (positive int)')
  .option(sessionOption[0], sessionOption[1])
  .action(async (boxRef: string, colsStr: string, rowsStr: string, opts: SessionOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const session = await resolveDriveSession(provider, box, opts.session);
      const cols = parsePositiveInt(colsStr, '<cols>');
      const rows = parsePositiveInt(rowsStr, '<rows>');
      await resizeWindow(provider, box, session.name, cols, rows);
    } catch (err) {
      handleDriveError(err);
    }
  });

driveCommand.addCommand(driveSnapshotCommand);
driveCommand.addCommand(driveKeypressCommand);
driveCommand.addCommand(driveSendTextCommand);
driveCommand.addCommand(drivePromptCommand);
driveCommand.addCommand(driveWaitCommand);
driveCommand.addCommand(driveResizeCommand);

function handleDriveError(err: unknown): never {
  if (err instanceof SessionNotFoundError) {
    log.error(err.message);
    log.info('start an agent first (e.g. `agentbox claude <box>`) or pass --session.');
    process.exit(2);
  }
  handleLifecycleError(err);
}

function parseRowRange(raw: string): { from: number; to: number } {
  const m = /^(-?\d+):(-?\d+)$/.exec(raw);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`--rows expects FROM:TO (got: ${raw})`);
  }
  return { from: Number(m[1]), to: Number(m[2]) };
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${label} must be a positive integer (got: ${raw})`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
