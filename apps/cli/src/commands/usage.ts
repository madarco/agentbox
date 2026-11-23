/**
 * `agentbox usage` — tokens the recorded sessions spent, from the hub
 * (docs/agent-history-plan.md, Phase 7). A `/api/v1/usage` client; the CLI
 * reads no store of its own.
 */
import { log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import { renderTable } from '../lib/text-table.js';
import { parseUsageBy, usageTable } from '../lib/usage-format.js';

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`expected a positive integer, got "${raw}"`);
  return n;
}

export const usageCommand = new Command('usage')
  .description(
    'Tokens spent by recorded agent sessions (every box, provider and PC that ships to the hub), grouped and filtered',
  )
  .option(
    '--by <dims>',
    'group by up to two of: day, agent, account, box, project, host, model, session (comma-separated; default agent)',
    'agent',
  )
  .option(
    '--since <when>',
    'start of the window: ISO-8601, a duration back from now (24h, 7d, 2w), or "all" (default 7d)',
    '7d',
  )
  .option('--until <when>', 'end of the window (exclusive), same forms as --since')
  .option('--agent <id>', 'only this agent (e.g. claude)')
  .option('--account <name>', 'only this named LLM account (default = the agent default login)')
  .option('--box <ref>', 'only this box (id or name)')
  .option('--project <text>', 'only projects whose repo URL contains this')
  .option('--host <machineId>', 'only sessions shipped by this PC')
  .option('--model <id>', 'only this model')
  .option('-n, --limit <n>', 'at most this many groups (default 200, max 1000)', positiveInt)
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print JSON')
  .action(
    async (opts: {
      by: string;
      since: string;
      until?: string;
      agent?: string;
      account?: string;
      box?: string;
      project?: string;
      host?: string;
      model?: string;
      limit?: number;
      local?: boolean;
      json?: boolean;
    }) => {
      const by = parseUsageBy(opts.by);
      await withHubClient(opts.local ? { preferLocal: true } : {}, async (client) => {
        const report = await client.usage({
          by,
          ...(opts.since !== 'all' ? { since: opts.since } : {}),
          until: opts.until,
          // Days in this machine's time zone.
          tzOffset: -new Date().getTimezoneOffset(),
          agent: opts.agent,
          account: opts.account,
          box: opts.box,
          project: opts.project,
          host: opts.host,
          model: opts.model,
          limit: opts.limit,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }
        if (report.totals.messages === 0) {
          log.info('No recorded usage matches.');
          return;
        }
        const t = usageTable(report.by, report.groups, report.totals);
        renderTable(t.headers, t.rows);
        if (report.truncated) {
          process.stdout.write(
            `\n… more groups than --limit ${String(opts.limit ?? 200)}; the total row covers them all\n`,
          );
        }
      });
    },
  );
