/**
 * Doctor probes for the remote-docker provider.
 *
 * There is no credential to check — the provider authenticates as you, through
 * your own `~/.ssh/config` and agent. What *can* be wrong is the destination:
 * unset, unreachable, or reachable but with no docker on the login-shell PATH.
 * So the checks are exactly those three, run against the configured default.
 */

import { loadEffectiveConfig } from '@agentbox/config';
import { detectPortless, portlessDoctorRow } from '@agentbox/sandbox-cloud';
import { errSummary, type CheckResult } from '@agentbox/sandbox-core';
import { probeRemoteEngine } from './remote-docker.js';
import { getHostAlias } from './hosts-registry.js';
import { readPreparedState } from './prepared-state.js';

// No `readCredStatus` / `ensureCredentials` on this provider's module, and that
// is not an omission: there is no credential to store or prompt for. The CLI
// and the hub both feature-detect those, so they simply show no login row.

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    const alias = (cfg.effective.box.remoteDockerHost || '').trim();
    if (!alias) {
      return [
        {
          label: 'remote engine',
          status: 'warn',
          detail: 'no default host alias set',
          hint: '`agentbox remote-docker add <alias> <[user@]host[:port]>`',
        },
      ];
    }
    // box.remoteDockerHost is an alias; resolve it through the registry.
    const entry = getHostAlias(alias);
    if (!entry) {
      return [
        {
          label: 'remote engine',
          status: 'warn',
          detail: `host alias '${alias}' is not registered`,
          hint: `\`agentbox remote-docker add ${alias} <[user@]host[:port]>\``,
        },
      ];
    }

    const probe = await probeRemoteEngine(entry.ssh);
    const engineRes: CheckResult = probe.ok
      ? {
          label: 'remote engine',
          status: 'ok',
          detail: `${alias} → ${entry.ssh} — docker ${probe.version} (${probe.os}/${probe.arch})`,
        }
      : {
          label: 'remote engine',
          status: 'fail',
          detail: probe.error ?? 'unusable',
          hint: `check that \`ssh ${entry.ssh} true\` works and docker is installed there`,
        };

    const prepared = readPreparedState();
    const baked = prepared?.hosts[alias];
    const imageRes: CheckResult = baked
      ? {
          label: 'box image',
          status: 'ok',
          detail: `${baked.imageRef} (${baked.cliVersion ?? '—'})`,
        }
      : {
          label: 'box image',
          status: 'warn',
          detail: 'not baked on this host yet',
          hint: `\`agentbox prepare --provider docker:${alias}\` (otherwise the first create bakes it)`,
        };

    // Host Portless mints the <box>.localhost alias for the SSH-forwarded port;
    // without it the box's web URL degrades to a raw loopback port.
    const portlessRes = portlessDoctorRow(await detectPortless());
    return [engineRes, imageRes, portlessRes];
  } catch (err) {
    return [{ label: 'remote engine', status: 'warn', detail: errSummary(err) }];
  }
}
