/**
 * The docker provider's uniform `ProviderModule` surface (see
 * `@agentbox/sandbox-core`'s `ProviderModule`). Docker is the local provider:
 * no cloud backend, no credentials/login, no base-snapshot fingerprint — just
 * the provider plus its doctor probes (moved here from apps/cli so the CLI
 * dispatches to it generically).
 */

import { execa } from 'execa';
import { errSummary, type CheckResult, type ProviderModule } from '@agentbox/sandbox-core';
import { dockerProvider } from './docker-provider.js';
import { DEFAULT_BOX_IMAGE, imageInfo } from './image.js';
import { volumeExists } from './docker.js';
import { detectEngine } from './sync/host-export.js';
import { detectPortless, portlessDoctorRow } from './portless.js';
import { SHARED_CLAUDE_VOLUME } from './sync/agents/claude.js';
import { SHARED_CODEX_VOLUME } from './sync/agents/codex.js';
import { SHARED_OPENCODE_VOLUME } from './sync/agents/opencode.js';

async function probeVersion(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const r = await execa(bin, args, { reject: false });
    if (r.exitCode !== 0) return null;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return out.length > 0 ? out : bin;
  } catch {
    return null;
  }
}

/** Local, offline-safe docker health probes for `agentbox doctor`. */
export async function dockerChecks(): Promise<CheckResult[]> {
  const linux = process.platform === 'linux';
  const cli = await probeVersion('docker');
  if (!cli) {
    return [
      {
        label: 'docker cli',
        status: 'warn',
        detail: 'not found',
        hint: linux
          ? 'install docker engine: https://docs.docker.com/engine/install/'
          : 'install Docker Desktop, OrbStack, or docker engine',
      },
    ];
  }
  const cliRes: CheckResult = { label: 'docker cli', status: 'ok', detail: cli };

  // Daemon reachability via `docker info`. On Linux the most common failure is
  // not a stopped daemon but the user missing from the `docker` group — `docker
  // info` then exits non-zero with "permission denied" on the socket.
  const info = await execa('docker', ['info'], { reject: false });
  if (info.exitCode !== 0) {
    const permDenied = `${info.stderr ?? ''}`.toLowerCase().includes('permission denied');
    let hint: string;
    if (permDenied && linux) {
      hint =
        'add your user to the docker group: `sudo usermod -aG docker $USER`, then log out/in (or run `newgrp docker`)';
    } else if (linux) {
      hint = 'start Docker: `sudo systemctl start docker` (install docker engine if missing)';
    } else {
      hint = 'start Docker (Desktop / OrbStack)';
    }
    return [
      cliRes,
      {
        label: 'docker daemon',
        status: 'warn',
        detail: permDenied ? 'permission denied' : 'unreachable',
        hint,
      },
    ];
  }
  const daemonRes: CheckResult = { label: 'docker daemon', status: 'ok', detail: 'reachable' };

  let imgRes: CheckResult;
  try {
    const img = await imageInfo(DEFAULT_BOX_IMAGE);
    imgRes = img.exists
      ? { label: 'box image', status: 'ok', detail: `${DEFAULT_BOX_IMAGE} built` }
      : {
          label: 'box image',
          status: 'warn',
          detail: `${DEFAULT_BOX_IMAGE} not built`,
          hint: 'run `agentbox prepare --provider docker` (or let the wizard do it)',
        };
  } catch (err) {
    imgRes = { label: 'box image', status: 'warn', detail: errSummary(err) };
  }

  const volNames = [SHARED_CLAUDE_VOLUME, SHARED_CODEX_VOLUME, SHARED_OPENCODE_VOLUME];
  const vols = await Promise.all(
    volNames.map(async (n) => ({ name: n, exists: await volumeExists(n).catch(() => false) })),
  );
  const present = vols.filter((v) => v.exists).length;
  const volRes: CheckResult = {
    label: 'shared volumes',
    status: 'ok',
    detail: `${String(present)}/${String(vols.length)} present (seeded lazily)`,
  };

  const results = [cliRes, daemonRes, imgRes, volRes];
  // OrbStack serves per-box .orb.local URLs natively; Portless only matters on
  // plain Docker Desktop / Linux docker engine.
  if ((await detectEngine().catch(() => 'other')) !== 'orbstack') {
    results.push(portlessDoctorRow(await detectPortless()));
  }
  return results;
}

export const providerModule: ProviderModule = {
  provider: dockerProvider,
  doctorChecks: dockerChecks,
};
