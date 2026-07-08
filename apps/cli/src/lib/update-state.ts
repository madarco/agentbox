/**
 * `~/.agentbox/update-state.json` — one stamp file for all update machinery:
 * the last CLI version the user acknowledged (drives the "you updated —
 * refresh now?" prompt in `index.ts`), the sha256 of the installed tray-app
 * zip (drives the sidecar-compare in `install-app.ts`), and the daily
 * remote-check cache (the ONLY place the CLI touches the network outside an
 * explicit install/update command).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1 as const;

/** Result of the daily remote check. `checkedAt` gates re-checking (24h). */
export interface RemoteCheck {
  checkedAt: string;
  npmLatest?: string;
  trayLatestSha?: string;
}

export interface UpdateState {
  version: typeof STATE_VERSION;
  /** CLI version last acknowledged (refresh completed or prompt declined). */
  lastRunVersion?: string;
  /** sha256 of the AgentBox.zip the installed tray app came from. */
  traySha?: string;
  remoteCheck?: RemoteCheck;
}

export function updateStatePath(): string {
  return join(homedir(), '.agentbox', 'update-state.json');
}

export function readUpdateState(): UpdateState {
  const path = updateStatePath();
  if (!existsSync(path)) return { version: STATE_VERSION };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateState>;
    const state: UpdateState = { version: STATE_VERSION };
    if (typeof parsed.lastRunVersion === 'string') state.lastRunVersion = parsed.lastRunVersion;
    if (typeof parsed.traySha === 'string') state.traySha = parsed.traySha;
    if (
      parsed.remoteCheck !== undefined &&
      typeof parsed.remoteCheck === 'object' &&
      typeof parsed.remoteCheck.checkedAt === 'string'
    ) {
      state.remoteCheck = {
        checkedAt: parsed.remoteCheck.checkedAt,
        ...(typeof parsed.remoteCheck.npmLatest === 'string'
          ? { npmLatest: parsed.remoteCheck.npmLatest }
          : {}),
        ...(typeof parsed.remoteCheck.trayLatestSha === 'string'
          ? { trayLatestSha: parsed.remoteCheck.trayLatestSha }
          : {}),
      };
    }
    return state;
  } catch {
    // Corrupt/unreadable — treat as fresh rather than breaking every command.
    return { version: STATE_VERSION };
  }
}

/**
 * Read-merge-write so concurrent writers (startup hook, tray install,
 * background remote check) don't clobber each other's fields. Pass an
 * explicit `undefined` value to delete a field.
 */
export function writeUpdateState(
  patch: Partial<Omit<UpdateState, 'version'>>,
): UpdateState {
  const state = readUpdateState();
  const merged: UpdateState = { ...state, ...patch, version: STATE_VERSION };
  for (const key of Object.keys(merged) as (keyof UpdateState)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  const path = updateStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True while the cached remote check is younger than 24h — no network then. */
export function remoteCheckFresh(state: UpdateState, now: Date = new Date()): boolean {
  const at = state.remoteCheck?.checkedAt;
  if (at === undefined) return false;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  // A future timestamp (clock skew, hand-edited file) also reads as fresh
  // until it ages out; treat anything > 24h in the future as stale instead.
  return now.getTime() - t < DAY_MS && t - now.getTime() < DAY_MS;
}
