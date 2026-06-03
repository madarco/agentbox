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
  formatDetailed,
  runAllChecks,
  runProviderChecks,
  runSystemChecks,
  worstStatus,
  type CheckGroup,
  type ProviderName,
} from '../lib/doctor-checks.js';
import { isKnownProvider } from '../provider/registry.js';

interface DoctorOptions {
  provider?: string;
}

export const doctorCommand = new Command('doctor')
  .description(
    'Diagnose system compatibility and provider readiness (Node, git, ssh, Docker daemon, provider credentials, prepared snapshots).',
  )
  .option(
    '-p, --provider <name>',
    'limit checks to one provider (docker | daytona | hetzner | vercel | e2b)',
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
      groups = [
        { title: 'system', results: await runSystemChecks() },
        await runProviderChecks(name as ProviderName),
      ];
    } else {
      groups = await runAllChecks();
    }

    process.stdout.write(formatDetailed(groups).join('\n') + '\n');

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
