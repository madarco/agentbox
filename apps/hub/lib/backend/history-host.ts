// Host sessions (docs/agent-history-plan.md, Phase 5): the hub machine's own
// watcher, as `/api/v1/history/host` serves it to the tray and the web UI. The
// watcher runs in this hub's relay and reads this machine's config, so the
// toggle writes this machine's `history.hostSessions` (global, or one project).
import {
  hostProjectDecisions,
  knownProjectFolders,
  readHostSessionsStatus,
  setHostSessionsEnabled,
  setHostSessionsProject,
  type HostProjectDecision,
  type HostProjectMode,
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

export interface HostSessionsPatch {
  enabled?: boolean;
  project?: { folder: string; mode: HostProjectMode };
}

export interface HostSessionsBackend {
  view(): Promise<HostSessionsView>;
  update(patch: HostSessionsPatch): Promise<HostSessionsView>;
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
    view,
    async update(patch) {
      if (patch.enabled !== undefined) await (deps.setEnabled ?? setHostSessionsEnabled)(patch.enabled);
      if (patch.project) {
        await (deps.setProject ?? setHostSessionsProject)(patch.project.folder, patch.project.mode);
      }
      return view();
    },
  };
}

/** Validate a `PUT /history/host` body. */
export function parseHostSessionsPatch(
  body: unknown,
): { ok: true; value: HostSessionsPatch } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: HostSessionsPatch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, message: 'enabled must be a boolean' };
    out.enabled = b.enabled;
  }
  if (b.project !== undefined) {
    const p = b.project as Record<string, unknown> | null;
    if (
      !p ||
      typeof p.folder !== 'string' ||
      !p.folder.startsWith('/') ||
      (p.mode !== 'allow' && p.mode !== 'deny' && p.mode !== 'inherit')
    ) {
      return {
        ok: false,
        message: 'project must be {folder: <absolute path>, mode: allow|deny|inherit}',
      };
    }
    out.project = { folder: p.folder, mode: p.mode };
  }
  if (out.enabled === undefined && !out.project) {
    return { ok: false, message: 'expected enabled and/or project' };
  }
  return { ok: true, value: out };
}
