// The relay seams the hub <-> PC skills slice (`skills-pc.ts`) runs on: the hub's
// own machine executes `pcskills.*` in-process, an enrolled device gets it through
// the control box's host-reach queue, routed to that device only.
import { getMachineLabel, loadEffectiveConfig, tryGetMachineId } from '@agentbox/config';
import {
  executePcSkillsAction,
  isPcSkillsMethod,
  pcSkillsActionId,
  type RelayServerHandle,
} from '@agentbox/relay';
import { homedir } from 'node:os';
import { hubRunsOnPc, type PcReach, type PcSkillsBackendDeps } from './skills-pc';

let maxBytesMemo: { at: number; value: number | undefined } | null = null;
const MEMO_MS = 30_000;

async function maxSkillBytes(): Promise<number | undefined> {
  if (maxBytesMemo && Date.now() - maxBytesMemo.at < MEMO_MS) return maxBytesMemo.value;
  const value = await loadEffectiveConfig(homedir())
    .then((c) => c.effective.skills.maxSkillBytes)
    .catch(() => undefined);
  maxBytesMemo = { at: Date.now(), value };
  return value;
}

export function pcSkillsDeps(
  handle: RelayServerHandle,
  base: Pick<PcSkillsBackendDeps, 'store' | 'maxTarballBytes' | 'skillsChanged'>,
): PcSkillsBackendDeps {
  const hostReach = handle.hostReach;
  return {
    ...base,
    self() {
      const id = tryGetMachineId();
      if (!id || !hubRunsOnPc()) return null;
      return { id, label: getMachineLabel() };
    },
    devices() {
      return (globalThis.__AGENTBOX_HUB_DEVICES?.list() ?? [])
        .filter((d) => d.revokedAt === null)
        .map((d) => ({ id: d.id, label: d.label }));
    },
    present: () => hostReach?.devicesPresent() ?? [],
    async runSelf(method, params): Promise<PcReach> {
      if (!isPcSkillsMethod(method)) throw new Error(`not a pcskills method: ${method}`);
      const maxBytes = await maxSkillBytes();
      // No confirm: the click in this hub's own UI is the owner's act on this machine.
      const r = await executePcSkillsAction(method, params, {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        log: (m) => console.warn(`[hub] ${m}`),
      });
      return { kind: 'result', ...r };
    },
    ...(hostReach
      ? {
          async runDevice(deviceId, label, method, params): Promise<PcReach> {
            const outcome = await hostReach.request(pcSkillsActionId(deviceId), method, params, {
              route: { candidates: [{ deviceId, label }] },
            });
            if (outcome.kind === 'result') return { kind: 'result', ...outcome.result };
            const t = outcome.tried?.[0];
            return {
              kind: 'unreachable',
              detail:
                t?.reason === 'declined'
                  ? `${label} declined: ${t.detail ?? 'no reason given'}`
                  : t?.reason === 'went-away'
                    ? `${label} went away before answering`
                    : `${label} is offline`,
            };
          },
        }
      : {}),
  };
}
