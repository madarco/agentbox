import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadEffectiveConfig, setConfigValue, unsetConfigValue } from '@agentbox/config';

/**
 * `history.hostSessions` as the host watcher reads it (agent-history Phase 5):
 * the global value is the opt-in toggle, a project's own value allows or denies
 * that project. One implementation for the watcher, the hub's
 * `/api/v1/history/host` and `agentbox sessions host`.
 */

const KEY = 'history.hostSessions';

export type HostProjectMode = 'allow' | 'deny' | 'inherit';

export interface HostProjectDecision {
  folder: string;
  repoUrl?: string;
  /** The project's own setting. */
  mode: HostProjectMode;
  allowed: boolean;
  /** `project` (its own value decided), `global`, `history.capture off`, or `off`. */
  reason: 'project' | 'global' | 'history.capture off' | 'config unreadable' | 'off';
}

export interface HostDecisions {
  /** The global toggle. */
  enabled: boolean;
  projects: HostProjectDecision[];
}

/**
 * The global toggle plus every known folder's decision. Only the user's own
 * layers count (this machine's global config, the folder's project config): a
 * checked-in agentbox.yaml `defaults` must never opt a user's PC sessions in.
 * A folder whose config cannot be read is denied (fail closed).
 */
export async function hostProjectDecisions(
  folders: ReadonlyArray<{ folder: string; originUrl?: string }>,
): Promise<HostDecisions> {
  const global = await loadEffectiveConfig(homedir()).catch(() => null);
  const enabled = global?.layers.global.values.history?.hostSessions === true;
  const projects: HostProjectDecision[] = [];
  for (const f of folders) {
    const loaded = await loadEffectiveConfig(f.folder).catch(() => null);
    const own = loaded?.layers.project.values.history?.hostSessions;
    const mode: HostProjectMode = own === true ? 'allow' : own === false ? 'deny' : 'inherit';
    // history.capture is an opt-OUT, so honouring it from any layer only denies more.
    const capture = loaded ? loaded.effective.history.capture !== false : false;
    const value = own ?? enabled;
    projects.push({
      folder: f.folder,
      ...(f.originUrl ? { repoUrl: f.originUrl } : {}),
      mode,
      allowed: capture && value,
      reason: !loaded
        ? 'config unreadable'
        : !capture
          ? 'history.capture off'
          : mode !== 'inherit'
            ? 'project'
            : value
              ? 'global'
              : 'off',
    });
  }
  return { enabled, projects };
}

/** Turn the watcher on or off on this machine (the global key). */
export async function setHostSessionsEnabled(enabled: boolean): Promise<void> {
  await setConfigValue('global', KEY, enabled, homedir());
}

/**
 * Allow, deny or reset one project folder. Writing the project key registers
 * the folder, which is what makes a folder agentbox never created a box for
 * (a desktop-app-only project) known to the watcher.
 */
export async function setHostSessionsProject(
  folder: string,
  mode: HostProjectMode,
): Promise<string> {
  const abs = await realpath(resolve(folder)).catch(() => resolve(folder));
  if (mode === 'inherit') await unsetConfigValue('project', KEY, abs);
  else await setConfigValue('project', KEY, mode === 'allow', abs);
  return abs;
}
