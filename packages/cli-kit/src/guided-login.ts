/**
 * Guided login: the TTY default for `agentbox <agent> login`.
 *
 * The legacy `interactive` passthrough hands the user's terminal straight to the
 * agent's own in-container TUI (`docker run -it`, `stdio: 'inherit'`). That TUI
 * negotiates raw-mode and enhanced-keyboard sequences with whatever emulator it
 * finds, and we control none of it — on kitty (CSI-u keyboard protocol) claude's
 * paste-code prompt stops accepting input entirely.
 *
 * Guided mode never gives the container the terminal. The login runs under a pty
 * ({@link runAgentLogin}), its raw stream goes to the command log, and we
 * reproduce the interaction with our own clack prompts on the host — which works
 * the same in every terminal.
 */
// Deliberately NOT `lib/prompt.js`: that wrapper exits the process on Ctrl+C,
// which would strand the login container. We need the cancel symbol back so we
// can abort the pty (killing `docker run --rm`) before exiting.
import { isCancel, log, password, spinner, text } from '@clack/prompts';
import { runAgentLogin } from './agent-login-run.js';
import type { AgentLoginBinding } from './agent-login-bindings.js';
import type { LoginNeed } from './agent-login-specs.js';
import { openCommandLog } from './log-file.js';

export interface GuidedLoginResult {
  ok: boolean;
  error?: string;
  warmed?: boolean;
  /** The container asked something we can't drive from the host (see the reason). */
  unsupported?: string;
  /** The user cancelled at one of our prompts. */
  cancelled?: boolean;
}

/** Show the approval URL on its own line so it stays clickable/selectable. */
function printUrl(url: string): void {
  process.stdout.write(`\n  ${url}\n\n`);
}

/**
 * `createBinding` is a factory rather than a value so the binding's own progress
 * notes (claude's warm-up) land in the command log this function opens.
 */
export async function runGuidedLogin(
  agent: string,
  createBinding: (writeLog: (line: string) => void) => AgentLoginBinding,
): Promise<GuidedLoginResult> {
  const cmdLog = openCommandLog(`${agent}-login`);
  const binding = createBinding((line) => cmdLog.write(line));
  const { spec } = binding;
  const abort = new AbortController();

  let pendingInput: string | null = null;
  let prompting = false;
  let cancelled = false;

  const s = spinner();
  let spinning = false;
  const startSpinner = (msg: string): void => {
    if (!spinning) {
      s.start(msg);
      spinning = true;
    } else s.message(msg);
  };
  const stopSpinner = (msg?: string): void => {
    if (!spinning) return;
    spinning = false;
    s.stop(msg);
  };

  /**
   * Collect what the container is waiting for. Fired from `onPhase` (sync), so
   * it runs detached; `prompting` keeps a re-published phase from stacking a
   * second prompt on the same question.
   */
  const promptFor = (need: LoginNeed, lastError?: string): void => {
    if (prompting || cancelled) return;
    prompting = true;
    void (async () => {
      stopSpinner();
      if (lastError) log.warn(lastError);

      let answer: string | symbol;
      if (need.kind === 'secret') {
        if (need.hint) log.info(`Create one at: ${need.hint}`);
        answer = await password({ message: `Enter your ${need.label}` });
      } else if (need.kind === 'paste-code') {
        log.info('Open this URL in a browser and approve access:');
        printUrl(need.url);
        answer = await text({
          message: 'Paste the code from the browser',
          validate: (v) => (v.trim().length === 0 ? 'Paste the code to continue' : undefined),
        });
      } else return; // browser-only / unsupported never prompt

      if (isCancel(answer)) {
        cancelled = true;
        cmdLog.write('cancelled at the host prompt');
        abort.abort();
        return;
      }
      pendingInput = answer.trim();
      prompting = false;
      startSpinner('completing sign-in');
    })();
  };

  startSpinner('starting sign-in');

  const result = await runAgentLogin({
    spec,
    dockerArgv: binding.dockerArgv,
    // The raw container stream goes to the log, NEVER to the user's terminal.
    writeRaw: (chunk) => cmdLog.raw(chunk),
    writeLog: (line) => cmdLog.write(line),
    onPhase: (phase, update) => {
      if (phase === 'awaiting-approval' && update?.url) {
        stopSpinner();
        log.info('Open this URL in a browser and sign in:');
        printUrl(update.url);
        if (update.userCode) log.info(`Enter this one-time code: ${update.userCode}`);
        startSpinner('waiting for you to approve in the browser');
        return;
      }
      if (phase === 'awaiting-code' && update?.need) {
        promptFor(update.need, update.lastError);
      }
    },
    getInput: () => {
      const v = pendingInput;
      pendingInput = null;
      return v;
    },
    verify: binding.verify,
    finalize: binding.finalize,
    signal: abort.signal,
  });

  stopSpinner();
  cmdLog.close();

  if (cancelled) return { ok: false, cancelled: true };
  return {
    ok: result.ok,
    error: result.error,
    warmed: result.warmed,
    unsupported: result.unsupported,
  };
}
