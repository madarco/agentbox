// Host sessions (docs/agent-history-plan.md, Phase 5): the hub machine's own
// watcher, as `/api/v1/history/host` serves it to the tray and the web UI. The
// watcher runs in this hub's relay and reads this machine's config, so the
// toggle writes this machine's `history.hostSessions` (global, or one project).
import type { HostSessionsPatch } from './history-host-patch';
import {
  hostProjectDecisions,
  knownProjectFolders,
  readHostSessionsStatus,
  setHostSessionsEnabled,
  setHostSessionsProject,
  type HostProjectDecision,
  type HostSessionsStatus,
} from '@agentbox/relay';

export interface HostSessionsView {
  /** The global toggle (`history.hostSessions` in this machine's global config). */
  enabled: boolean;
  /** Every folder the watcher considers, with its own setting and the outcome. */
  projects: HostProjectDecision[];
  /** The watcher's last pass, or null when it has not run on this machine. */
  status: HostSessionsStatus | null;
}

export type { HostSessionsPatch } from './history-host-patch';

export interface HostSessionsBackend {
  hostSessionsView(): Promise<HostSessionsView>;
  updateHostSessions(patch: HostSessionsPatch): Promise<HostSessionsView>;
}

export function createHostSessionsBackend(
  deps: {
    decide?: typeof hostProjectDecisions;
    folders?: typeof knownProjectFolders;
    status?: typeof readHostSessionsStatus;
    setEnabled?: typeof setHostSessionsEnabled;
    setProject?: typeof setHostSessionsProject;
  } = {},
): HostSessionsBackend {
  const decide = deps.decide ?? hostProjectDecisions;
  const folders = deps.folders ?? knownProjectFolders;
  const status = deps.status ?? readHostSessionsStatus;
  const view = async (): Promise<HostSessionsView> => {
    const d = await decide(await folders());
    return { enabled: d.enabled, projects: d.projects, status: await status() };
  };
  return {
    hostSessionsView: view,
    async updateHostSessions(patch) {
      if (patch.enabled !== undefined) await (deps.setEnabled ?? setHostSessionsEnabled)(patch.enabled);
      if (patch.project) {
        await (deps.setProject ?? setHostSessionsProject)(patch.project.folder, patch.project.mode);
      }
      return view();
    },
  };
}
