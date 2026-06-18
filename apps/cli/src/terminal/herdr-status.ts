import { loadEffectiveConfig } from '@agentbox/config';
import type { AgentActivityState } from '@agentbox/ctl';
import type { PromptAskEvent } from '@agentbox/relay';
import { herdrSend } from './herdr-socket.js';

/**
 * Surface a box's live agent activity to Herdr (https://herdr.dev) so the box
 * pane looks like a *normal* agent pane in Herdr's UI.
 *
 * Unlike the cmux integration (which has to drive the workspace colour because
 * cmux won't draw its agent pill for a `docker exec`), Herdr has a first-class
 * agent model: we report the box agent's state with `pane.report_agent`
 * (`agent: "claude"|"codex"|"opencode"`) and Herdr applies its native agent
 * treatment — including its own needs-input handling. So we deliberately do NOT
 * re-implement needs-input toasts here; Herdr does that from the `blocked`
 * state. The one thing Herdr can't know about is AgentBox's own host-relay
 * approval prompts (git push / PR / checkpoint …), so those get an explicit
 * `notification.show` (see {@link notifyHerdrApprovalPrompt}).
 *
 * The attach wrapper, which runs inside the Herdr pane and already polls the
 * box's status.json, reports on each activity transition and resets the pane to
 * idle on detach.
 */
export type HerdrAgentMode = 'claude' | 'codex' | 'opencode' | 'shell';

/** Herdr's semantic agent states (https://herdr.dev/docs/socket-api). */
type HerdrSemanticState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

interface HerdrAgentView {
  state: HerdrSemanticState;
  /** Short human label shown alongside the agent. */
  message: string;
}

const AGENT_LABEL: Record<Exclude<HerdrAgentMode, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * Map our coarse activity union onto a Herdr agent state. `null` means "leave
 * the pane as-is" (unknown/absent state, or shell). `question`/`waiting`/
 * `end-plan`/`error` all map to `blocked` — Herdr's native needs-input — so we
 * don't surface our own notification for those.
 */
export function mapActivityToAgentState(
  mode: HerdrAgentMode,
  activity: AgentActivityState | undefined,
): HerdrAgentView | null {
  if (mode === 'shell') return null;
  const label = AGENT_LABEL[mode];
  switch (activity) {
    case 'working':
    case 'compacting':
      return { state: 'working', message: `${label} · working` };
    case 'question':
    case 'waiting':
      return { state: 'blocked', message: `${label} · needs input` };
    case 'end-plan':
      return { state: 'blocked', message: `${label} · plan ready` };
    case 'error':
      return { state: 'blocked', message: `${label} · error` };
    case 'idle':
      return { state: 'idle', message: `${label} · idle` };
    case 'unknown':
    case undefined:
    default:
      return null;
  }
}

/**
 * True when attached inside a live Herdr pane. Herdr exports `HERDR_ENV=1`,
 * `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`; we need all three to report on this
 * pane. Keyed directly on the env (not `detectHostTerminal`, which prefers tmux
 * when nested) so it still works when a tmux runs inside Herdr.
 */
export function herdrStatusActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const sock = env['HERDR_SOCKET_PATH'];
  const pane = env['HERDR_PANE_ID'];
  return (
    env['HERDR_ENV'] === '1' &&
    typeof sock === 'string' &&
    sock.length > 0 &&
    typeof pane === 'string' &&
    pane.length > 0
  );
}

/**
 * Whether to drive Herdr: requires a live Herdr pane AND the
 * `attach.herdrStatus` config (default true). Best-effort — a config-load
 * failure defaults to on so the feature degrades to enabled, never crashes the
 * attach.
 */
export async function herdrStatusEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!herdrStatusActive(env)) return false;
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.attach.herdrStatus;
  } catch {
    return true;
  }
}

/** Report the box agent's activity on this Herdr pane. */
export function reportHerdrAgentState(
  mode: HerdrAgentMode,
  activity: AgentActivityState | undefined,
  boxName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const view = mapActivityToAgentState(mode, activity);
  if (!view) return;
  const pane = env['HERDR_PANE_ID'];
  if (!pane) return;
  herdrSend(
    'pane.report_agent',
    {
      pane_id: pane,
      source: `agentbox:${mode}`,
      agent: mode,
      state: view.state,
      message: view.message,
      // Carry the box name so the box is identifiable in Herdr's agent list.
      custom_status: boxName,
    },
    env,
  );
}

/** Reset this Herdr pane's agent to idle on detach. */
export function clearHerdrAgentState(
  mode: HerdrAgentMode,
  boxName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (mode === 'shell') return;
  const pane = env['HERDR_PANE_ID'];
  if (!pane) return;
  herdrSend(
    'pane.report_agent',
    {
      pane_id: pane,
      source: `agentbox:${mode}`,
      agent: mode,
      state: 'idle',
      message: `${AGENT_LABEL[mode]} · detached`,
      custom_status: boxName,
    },
    env,
  );
}

/** Herdr's notification body cap (sanitized to 240 chars server-side). */
const NOTIFY_BODY_MAX = 200;

/**
 * The special highlight for AgentBox's own host-relay approval prompts (git
 * push / PR / merge / cp / download / checkpoint). Herdr has no knowledge of
 * these, so unlike agent needs-input (which Herdr handles natively from the
 * `blocked` state) we surface them explicitly with a `request`-sounding toast.
 */
export function notifyHerdrApprovalPrompt(
  boxName: string,
  prompt: PromptAskEvent,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const detail = prompt.detail ? ` — ${prompt.detail}` : '';
  let body = `agentbox · ${prompt.message}${detail}`;
  if (body.length > NOTIFY_BODY_MAX) body = `${body.slice(0, NOTIFY_BODY_MAX - 1)}…`;
  herdrSend('notification.show', { title: boxName, body, sound: 'request' }, env);
}
