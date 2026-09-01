/**
 * Restore the agent that was running in a box before it stopped — so a restart
 * (or a cloud idle-timeout resume) looks like the box never went down.
 *
 * The box's agent runs as a detached tmux session that dies with the
 * container/VM; the agent's session files survive in the (shared) config
 * volumes, but those are pooled across every box, so a file probe can't tell
 * whose session is whose. Instead the in-box activity hooks capture the live
 * session into per-box pointer files on the box's own writable layer (see
 * `@agentbox/ctl`'s session-pointer.ts):
 *   - `~/.local/state/agentbox/claude-session` — the exact Claude session id
 *     (claude exposes it on every hook payload; updated on /new, /branch).
 *   - `~/.local/state/agentbox/codex-active`    — presence marker (Codex exposes
 *     no resumable id, so restore falls back to `codex resume --last`).
 *
 * On restart we read those pointers over `provider.exec` and relaunch the agent
 * resuming the exact (claude) / most-recent-in-cwd (codex) session. An agent
 * that declares no `caps.resume` is skipped — it has nothing to resume.
 */
import { loadEffectiveConfig } from '@agentbox/config';
import type { AgentId, BoxRecord, Provider } from '@agentbox/core';
import { agentIds, resolveAgentSpec } from '@agentbox/sandbox-core';
import { loadAgentModule, loadAgentModuleOrNull } from './agents/index.js';
import { cloudAgentStartDetached } from './commands/_cloud-attach.js';

/**
 * Agents that support session resume, straight from `caps.resume` — the same
 * declaration `fork --session` and `prepareTeleport` gate on. It was a literal
 * `'claude' | 'codex'` here, which is the capability said a second time and in a
 * place nothing would update.
 */
export function resumableAgents(): AgentId[] {
  return agentIds().filter((id) => resolveAgentSpec(id).caps.resume);
}

/** Run a small read-only shell snippet in the box; '' on any failure. */
async function execRead(provider: Provider, box: BoxRecord, script: string): Promise<string> {
  try {
    const r = await provider.exec(box, ['bash', '-lc', script], { user: 'vscode' });
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** True if a tmux session by this name is already alive in the box. */
async function tmuxAlive(
  provider: Provider,
  box: BoxRecord,
  sessionName: string,
): Promise<boolean> {
  const q = `'${sessionName.replace(/'/g, `'\\''`)}'`;
  return (await execRead(provider, box, `tmux has-session -t ${q} 2>/dev/null && echo y`)) === 'y';
}

/** Kill a live agent tmux session so it can be relaunched with a fresh env. */
async function killTmuxSession(
  provider: Provider,
  box: BoxRecord,
  sessionName: string,
): Promise<void> {
  const q = `'${sessionName.replace(/'/g, `'\\''`)}'`;
  await provider
    .exec(box, ['bash', '-lc', `tmux kill-session -t ${q} 2>/dev/null || true`], { user: 'vscode' })
    .catch(() => {});
}

/**
 * The args to resume the box's recorded session for `kind`, or null if there's
 * nothing to resume. Skip-permissions is NOT applied here — callers layer it via
 * their own config (the attach paths already do).
 *
 * An agent with no resume support gets null, which is the safe answer: falling
 * through to another agent's probe would restore the wrong session. This was an
 * `if (claude) … else codex` chain the compiler proved total while the parameter
 * was `'claude' | 'codex'`; with `AgentId` open its `else` would have handed
 * every future agent Codex's marker file and Codex's argv.
 */
export async function agentResumeArgs(
  provider: Provider,
  box: BoxRecord,
  kind: AgentId,
): Promise<string[] | null> {
  if (!resolveAgentSpec(kind).caps.resume) return null;
  // Null, not a throw: `resumableAgents()` walks the OPEN registry, so `kind`
  // can be a package this build has no CLI module for.
  const mod = await loadAgentModuleOrNull(kind);
  if (!mod?.runtime.resume) return null;
  return mod.runtime.resume.resumeArgs((script) => execRead(provider, box, script));
}

export interface RestoreOptions {
  onLog?: (line: string) => void;
  /**
   * Restrict the restore to a SINGLE agent: bring back exactly this one —
   * resume its session if there's a live one or a resumable in-box pointer,
   * otherwise start it FRESH. Used by `agentbox recover`, which knows the box's
   * `lastAgent` and wants that agent back, not whatever other (possibly stale)
   * pointers happen to exist in the box. When unset, resume EVERY resumable
   * agent that was running — the `start`/`unpause` "box never went down"
   * semantics. An agent with no session resume only ever comes back via the
   * fresh path here.
   */
  restoreOnly?: AgentId;
  /**
   * With `restoreOnly`: if that agent's session is already alive, KILL it first
   * and relaunch (resuming), instead of leaving the running one untouched. Used
   * to force the agent to pick up an environment change made after it started
   * (e.g. `connect --dangerously-git-credentials` flipping the box to git direct
   * mode) — a running session's env is otherwise frozen.
   */
  force?: boolean;
}

/** Start a fresh (no-resume) detached agent session. */
async function startFreshSession(
  box: BoxRecord,
  kind: AgentId,
  sessionName: string,
  cfg: Awaited<ReturnType<typeof loadEffectiveConfig>> | null,
  isDocker: boolean,
): Promise<void> {
  const { runtime } = await loadAgentModule(kind);
  const args =
    cfg && runtime.skipPermissions ? runtime.skipPermissions.apply([], cfg.effective) : [];
  if (isDocker) {
    await runtime.startSession({
      container: box.container,
      args,
      sessionName,
      boxName: box.name,
      workspacePath: box.workspacePath,
    });
  } else {
    await cloudAgentStartDetached({ box, binary: kind, sessionName, extraArgs: args });
  }
}

/**
 * Re-launch (detached) whichever agents the box had running, resuming their
 * session. Idempotent: an already-live tmux session is left as-is. Best-effort
 * per agent — a relaunch failure is logged, never thrown (a box restart must not
 * fail because an agent couldn't resume).
 *
 * The box must already be running (call after `provider.start` / `startBox` /
 * `provider.reconnect`).
 */
export async function restoreAgentSessions(
  box: BoxRecord,
  provider: Provider,
  opts: RestoreOptions = {},
): Promise<void> {
  const cfg = await loadEffectiveConfig(box.workspacePath).catch(() => null);
  const isDocker = (box.provider ?? 'docker') === 'docker';
  const sessionNameFor = async (kind: AgentId): Promise<string> => {
    const mod = await loadAgentModuleOrNull(kind);
    // The registry's own `sessionName` is the answer for an agent with no
    // module in this build — the same fallback as having no config to read.
    return cfg && mod
      ? mod.runtime.sessionNameOf(cfg.effective)
      : resolveAgentSpec(kind).sessionName;
  };

  // Resume one resumable agent from its in-box pointer. Returns true if it
  // (re)launched, false if there was nothing to resume / it failed.
  const tryResume = async (kind: AgentId, sessionName: string): Promise<boolean> => {
    const resume = await agentResumeArgs(provider, box, kind);
    if (!resume) return false;
    // Non-null resume args mean the module loaded above.
    const { runtime } = await loadAgentModule(kind);
    const args =
      cfg && runtime.skipPermissions
        ? runtime.skipPermissions.apply(resume, cfg.effective)
        : resume;
    try {
      if (isDocker) {
        await runtime.startSession({
          container: box.container,
          args,
          sessionName,
          boxName: box.name,
          workspacePath: box.workspacePath,
        });
      } else {
        await cloudAgentStartDetached({ box, binary: kind, sessionName, extraArgs: args });
      }
      opts.onLog?.(`resumed ${kind} session`);
      return true;
    } catch (err) {
      opts.onLog?.(`could not resume ${kind} session: ${(err as Error).message}`);
      return false;
    }
  };

  // recover: bring back exactly the named agent — resume if there's a live or
  // resumable session, else start it fresh. Don't touch other agents whose
  // (possibly stale) pointers happen to exist.
  const only = opts.restoreOnly;
  if (only) {
    const sessionName = await sessionNameFor(only);
    if (await tmuxAlive(provider, box, sessionName)) {
      if (!opts.force) return;
      // Force: kill the running session so it relaunches with the current box
      // env (e.g. after flipping to git direct mode). A resumable agent then
      // resumes the same conversation via its in-box pointer below.
      await killTmuxSession(provider, box, sessionName);
      opts.onLog?.(`stopped the running ${only} session to restart it`);
    }
    if (await tryResume(only, sessionName)) return;
    try {
      await startFreshSession(box, only, sessionName, cfg, isDocker);
      opts.onLog?.(`started ${only} session`);
    } catch (err) {
      opts.onLog?.(`could not start ${only} session: ${(err as Error).message}`);
    }
    return;
  }

  // start/unpause: resume every resumable agent that was actually running.
  for (const kind of resumableAgents()) {
    const sessionName = await sessionNameFor(kind);
    if (await tmuxAlive(provider, box, sessionName)) continue;
    await tryResume(kind, sessionName);
  }
}
