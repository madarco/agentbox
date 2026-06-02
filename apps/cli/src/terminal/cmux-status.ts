import { spawn, spawnSync } from 'node:child_process';
import { loadEffectiveConfig } from '@agentbox/config';
import type { AgentActivityState } from '@agentbox/ctl';
import { cmuxBinary } from './host.js';

/**
 * Surface a box's live agent activity on its cmux workspace so you can see, from
 * the cmux sidebar, what the agent in each box is doing.
 *
 * cmux (https://cmux.com) does have a per-workspace status *pill* (`set-status`),
 * but it only *renders* that pill for workspaces cmux recognizes as running an
 * agent (its own claude/codex/opencode integrations). A box runs the agent
 * inside the container, so cmux sees a generic `docker exec`/`ssh` process, never
 * draws the pill row, and `set-status` is silently stored-but-hidden. What cmux
 * *does* always render for any workspace is its colour and description — so we
 * drive those instead (verified empirically against cmux's CLI). The attach
 * wrapper, which runs inside the cmux surface and already polls the box's
 * status.json, captures the workspace's original colour/description on attach and
 * restores them on detach.
 */
export type CmuxAgentMode = 'claude' | 'codex' | 'opencode' | 'shell';

/** The workspace's prior colour/description, captured so we can restore on detach. */
export interface CmuxWorkspaceState {
  description: string;
  /** cmux named colour or #hex; '' means no colour. */
  color: string;
}

interface CmuxStateView {
  description: string;
  /** cmux named colour; '' clears the tint. */
  color: string;
}

const AGENT_LABEL: Record<Exclude<CmuxAgentMode, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * Map our coarse activity union onto a cmux workspace colour + description.
 * `null` means "leave the workspace as-is" (unknown/absent state, or shell).
 * Colours are cmux's named palette (Blue/Amber/Red); '' clears the tint.
 */
export function mapActivityToWorkspace(
  mode: CmuxAgentMode,
  activity: AgentActivityState | undefined,
): CmuxStateView | null {
  if (mode === 'shell') return null;
  const label = AGENT_LABEL[mode];
  switch (activity) {
    case 'working':
    case 'compacting':
      return { description: `${label} · working`, color: 'Blue' };
    case 'question':
    case 'waiting':
      return { description: `${label} · needs input`, color: 'Amber' };
    case 'end-plan':
      return { description: `${label} · plan ready`, color: 'Amber' };
    case 'error':
      return { description: `${label} · error`, color: 'Red' };
    case 'idle':
      return { description: `${label} · idle`, color: '' };
    case 'unknown':
    case undefined:
    default:
      return null;
  }
}

/**
 * States where the agent is blocked on the user. When a box's tab is one of
 * several in a workspace, this is what we flag (`markCmuxTabAttention`) so the
 * specific tab that needs input stands out among its siblings.
 */
export function isAttentionState(activity: AgentActivityState | undefined): boolean {
  return (
    activity === 'question' ||
    activity === 'waiting' ||
    activity === 'end-plan' ||
    activity === 'error'
  );
}

/**
 * True when attached inside a live cmux surface. cmux exports `CMUX_SOCKET_PATH`
 * for the in-surface shell; we key on it directly (rather than
 * `detectHostTerminal`, which prefers tmux when nested) so it still works when a
 * tmux runs inside cmux.
 */
export function cmuxStatusActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const sock = env['CMUX_SOCKET_PATH'];
  return typeof sock === 'string' && sock.length > 0;
}

/**
 * Whether to drive cmux: requires a live cmux surface AND the `attach.cmuxStatus`
 * config (default true). Best-effort — a config-load failure defaults to on so
 * the feature degrades to enabled, never crashes the attach.
 */
export async function cmuxStatusEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!cmuxStatusActive(env)) return false;
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.attach.cmuxStatus;
  } catch {
    return true;
  }
}

/** Fire-and-forget a cmux CLI command; never throws, never blocks the wrapper. */
function runCmux(argv: string[]): void {
  try {
    const child = spawn(cmuxBinary(), argv, { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort: cmux missing / spawn refused
  }
}

/**
 * Read the current cmux workspace's existing colour + description so the attach
 * can restore them on detach. Synchronous (one-shot at attach start). Returns
 * null if it can't be resolved — callers then clear on detach instead.
 */
export function captureCmuxWorkspace(
  env: NodeJS.ProcessEnv = process.env,
): CmuxWorkspaceState | null {
  const wsId = env['CMUX_WORKSPACE_ID'];
  if (!wsId) return null;
  try {
    const r = spawnSync(cmuxBinary(), ['list-workspaces', '--json', '--id-format', 'both'], {
      encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) return null;
    const data = JSON.parse(r.stdout) as { workspaces?: Array<Record<string, unknown>> };
    for (const w of data.workspaces ?? []) {
      // `--id-format both` includes the workspace UUID somewhere in the entry;
      // match it loosely so we don't depend on the exact field name.
      if (!JSON.stringify(w).includes(wsId)) continue;
      const description = typeof w['description'] === 'string' ? (w['description'] as string) : '';
      const color = typeof w['custom_color'] === 'string' ? (w['custom_color'] as string) : '';
      return { description, color };
    }
  } catch {
    // best-effort
  }
  return null;
}

/** Set the current cmux workspace's colour + description to reflect agent state. */
export function applyCmuxAgentState(
  mode: CmuxAgentMode,
  activity: AgentActivityState | undefined,
): void {
  const view = mapActivityToWorkspace(mode, activity);
  if (!view) return;
  runCmux(['workspace-action', '--action', 'set-description', '--description', view.description]);
  if (view.color) {
    runCmux(['workspace-action', '--action', 'set-color', '--color', view.color]);
  } else {
    runCmux(['workspace-action', '--action', 'clear-color']);
  }
}

/**
 * Highlight the box's own cmux tab so it stands out among sibling tabs in the
 * same workspace (boxes opened with `--attach-in tab`). `mark-unread` targets the
 * caller's tab by default ($CMUX_TAB_ID → $CMUX_SURFACE_ID) and cmux clears it
 * automatically when the user focuses the tab to answer.
 */
export function markCmuxTabAttention(): void {
  runCmux(['tab-action', '--action', 'mark-unread']);
}

/** Restore the workspace's colour + description captured at attach time. */
export function restoreCmuxWorkspace(orig: CmuxWorkspaceState | null): void {
  if (orig && orig.description) {
    runCmux(['workspace-action', '--action', 'set-description', '--description', orig.description]);
  } else {
    runCmux(['workspace-action', '--action', 'clear-description']);
  }
  if (orig && orig.color) {
    runCmux(['workspace-action', '--action', 'set-color', '--color', orig.color]);
  } else {
    runCmux(['workspace-action', '--action', 'clear-color']);
  }
}
