import { log } from '@clack/prompts';
import { Command } from 'commander';
import type { WaitReadyReply } from '@agentbox/ctl';
import { execInBox } from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';
import { requireDockerProvider } from './_provider-guard.js';

interface WaitOptions {
  timeout: string;
  units?: string[];
  json?: boolean;
}

export const waitCommand = new Command('wait')
  .description('Block until the box reports all autostart units ready')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--timeout <ms>', 'overall timeout in milliseconds', '120000')
  .option('--units <names...>', 'restrict to the named units')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (idOrName: string | undefined, opts: WaitOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'wait');

      const ctlArgs = ['agentbox-ctl', 'wait-ready', '--json', '--timeout', opts.timeout];
      if (opts.units && opts.units.length > 0) {
        ctlArgs.push('--units', ...opts.units);
      }
      const proc = await execInBox(box.container, ctlArgs, { user: 'vscode' });
      // wait-ready exits 0 on ready, 1 on not-ready; both write JSON.
      let parsed: WaitReadyReply;
      try {
        parsed = JSON.parse(proc.stdout) as WaitReadyReply;
      } catch {
        log.error(`agentbox-ctl wait-ready failed: ${proc.stderr || proc.stdout}`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
      } else if (parsed.ready) {
        process.stdout.write('ready\n');
      } else {
        const lines: string[] = ['not ready'];
        if (parsed.timedOut.length > 0) lines.push(`  timed out: ${parsed.timedOut.join(', ')}`);
        if (parsed.failed.length > 0) lines.push(`  failed: ${parsed.failed.join(', ')}`);
        process.stdout.write(lines.join('\n') + '\n');
      }
      process.exit(parsed.ready ? 0 : 1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
