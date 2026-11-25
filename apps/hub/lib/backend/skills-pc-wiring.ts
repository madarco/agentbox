// The relay seams the hub <-> PC skills slice (`skills-pc.ts`) runs on: the hub's
// own machine executes `pcskills.*` in-process, an enrolled device gets it through
// the control box's host-reach queue, routed to that device only.
import { readFileSync } from 'node:fs';
import { getMachineLabel, loadEffectiveConfig, tryGetMachineId } from '@agentbox/config';
import {
  executePcSkillsAction,
  isPcSkillsMethod,
  pcSkillsActionId,
  type RelayServerHandle,
} from '@agentbox/relay';
import { controlPlaneDeployPath } from '@agentbox/sandbox-core';
import { homedir } from 'node:os';
import type { PcReach, PcSkillsBackendDeps } from './skills-pc';

let deployedMemo: { at: number; value: boolean } | null = null;
let maxBytesMemo: { at: number; value: number | undefined } | null = null;
const MEMO_MS = 30_000;

/**
 * Whether this hub runs on a deployed server rather than a PC: a deploy record
 * for any provider but `local` (`hub expose` keeps the PC a PC). Its skill dirs
 * are not anyone's, so it is not offered as a machine.
 */
function isDeployedServer(): boolean {
  if (deployedMemo && Date.now() - deployedMemo.at < MEMO_MS) return deployedMemo.value;
  const value = readDeployedServer();
  deployedMemo = { at: Date.now(), value };
  return value;
}

async function maxSkillBytes(): Promise<number | undefined> {
  if (maxBytesMemo && Date.now() - maxBytesMemo.at < MEMO_MS) return maxBytesMemo.value;
  const value = await loadEffectiveConfig(homedir())
    .then((c) => c.effective.skills.maxSkillBytes)
    .catch(() => undefined);
  maxBytesMemo = { at: Date.now(), value };
  return value;
}

function readDeployedServer(): boolean {
  try {
    const rec = JSON.parse(readFileSync(controlPlaneDeployPath(), 'utf8')) as {
      provider?: string;
    };
    return typeof rec.provider === 'string' && rec.provider !== 'local';
  } catch {
    return false;
  }
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
      if (!id || isDeployedServer()) return null;
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
