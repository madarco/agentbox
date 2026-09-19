/**
 * `agentbox doctor` — full system + provider compatibility report.
 *
 * Reuses the shared probes in `../lib/doctor-checks.ts`. `agentbox install`
 * runs the same checks for its compact one-line summary; doctor prints the
 * full grouped detail. Exits non-zero only on a hard failure (Node too old,
 * `~/.agentbox` not writable) — "provider not set up" stays exit 0 since
 * that is the expected pre-onboarding state.
 */

import { Command } from 'commander';
import {
  buildDoctorReport,
  formatDetailed,
  runAllChecks,
  runProviderChecks,
  runSystemChecks,
  toolsChecks,
  worstStatus,
  type CheckGroup,
  type ProviderName,
} from '../lib/doctor-checks.js';
import { isKnownProvider } from '../provider/registry.js';
import { fetchControlBoxInventory, renderControlBoxProviders } from './prepare.js';

interface DoctorOptions {
  provider?: string;
  json?: boolean;
}

export const doctorCommand = new Command('doctor')
  .description(
    'Diagnose system compatibility and provider readiness (Node, git, ssh, Docker daemon, provider credentials, prepared snapshots).',
  )
  .option(
    '-p, --provider <name>',
    'limit checks to one provider (docker | daytona | hetzner | vercel | e2b)',
  )
  .option(
    '--json',
    "print the report as JSON ({ version, platform, status, groups, portless, controlBox }) — what the menu-bar app reads; `controlBox` carries the control box's own providers + bakes, and is absent when none is configured (or it is this machine)",
  )
  .action(async (opts: DoctorOptions) => {
    let groups: CheckGroup[];
    if (opts.provider) {
      const name = opts.provider.trim();
      if (!isKnownProvider(name)) {
        process.stderr.write(
          'error: --provider must be one of: docker, daytona, hetzner, vercel, e2b\n',
        );
        process.exit(1);
      }
      // Host tools are host-side, not provider-side, but a user running
      // `doctor -p hetzner` still wants to see whether their granted CLIs are
      // installed — otherwise the only way to reach the tools group is the
      // unscoped doctor, which is a discoverability gap.
      const [sys, prov, tools] = await Promise.all([
        runSystemChecks(),
        runProviderChecks(name as ProviderName),
        toolsChecks(),
      ]);
      groups = [{ title: 'system', results: sys }, prov, { title: 'tools', results: tools }];
    } else {
      groups = await runAllChecks();
    }

    if (opts.json === true) {
      // JSON only on stdout: no trailing prose. The control-box inventory IS
      // included (it is the only thing saying which machine builds cloud boxes,
      // and the tray reads this report) but can never fail the command — an
      // unreachable box lands as `controlBox.reachable: false`. The exit code
      // keeps the fail rule below, which reads `groups` only.
      const report = await buildDoctorReport(groups, {
        controlBox: () => fetchControlBoxInventory(),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.status === 'fail') process.exit(1);
      return;
    }

    process.stdout.write(formatDetailed(groups).join('\n') + '\n');

    // The provider rows above are local probes (this machine's credentials +
    // prepared-state). With a control box configured, ITS baked providers are the
    // ones a cloud create boots — so append its inventory, read from
    // `GET /api/v1/providers?freshness=1`. Empty (and silent) for a co-located
    // local hub, where the local rows already describe it.
    const controlBox = await renderControlBoxProviders().catch(() => [] as string[]);
    if (controlBox.length > 0) process.stdout.write(controlBox.join('\n') + '\n');

    const worst = worstStatus(groups);
    if (worst === 'fail') {
      process.stdout.write(
        '\nOne or more required checks failed. Fix the FAIL items above before continuing.\n',
      );
      process.exit(1);
    }
    if (worst === 'warn') {
      process.stdout.write(
        '\nWarnings are providers that need setup. Run `agentbox install` to configure one,\n' +
          'or `agentbox prepare --status` to see remote snapshot inventory.\n',
      );
    } else {
      process.stdout.write('\nAll checks passed.\n');
    }
  });
