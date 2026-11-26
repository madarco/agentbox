/**
 * `agentbox usage` — what the boxes did in a window: agent-hours, parallelism and
 * what shipped (docs/usage-dashboard-plan.md, Phase 2), from `/api/v1/usage/stats`.
 * `agentbox usage tokens` — tokens the recorded sessions spent, grouped
 * (docs/agent-history-plan.md, Phase 7), from `/api/v1/usage`. Both are hub
 * clients; the CLI reads no store of its own.
 */
import { confirm, isCancel, log, text } from '@agentbox/cli-kit';
import { HANDLE_RE } from '@agentbox/usage-view';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import { renderTable } from '../lib/text-table.js';
import { parseUsageBy, usageHeroLines, usageTable } from '../lib/usage-format.js';

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`expected a positive integer, got "${raw}"`);
  return n;
}

const tokensCommand = new Command('tokens')
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
  .option(
    '--account <name>',
    'only this subscription, as <agent>/<account> (claude/work); a bare name matches that account of any agent',
  )
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

const shareCommand = new Command('share')
  .description(
    "Publish the window's usage on agent-box.sh (share.endpoint) and print its public URL. Only metrics leave the hub, with the handle: no box, project, branch, PR or session name",
  )
  .option(
    '--handle <handle>',
    'public handle, lowercase letters, digits and dashes (default: the last one shared)',
  )
  .option(
    '--since <when>',
    'first day: YYYY-MM-DD, or a number of days or weeks ending at --until (30d, 2w, 365d)',
    '30d',
  )
  .option('--until <day>', 'last day, YYYY-MM-DD (default today)')
  .option('--tz <zone>', "IANA time zone the days are in (default this machine's)")
  .option('--subscription <agent/account>', 'only sessions and boxes on this subscription')
  .option('--dry-run', 'print the JSON that would be sent and post nothing')
  .option('-y, --yes', 'do not ask before publishing')
  .option('--local', "use this machine's hub instead of the configured one")
  .action(
    async (opts: {
      handle?: string;
      since: string;
      until?: string;
      tz?: string;
      subscription?: string;
      dryRun?: boolean;
      yes?: boolean;
      local?: boolean;
    }) => {
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      await withHubClient(opts.local ? { preferLocal: true } : {}, async (client) => {
        const settings = await client.usageShareSettings();
        let handle = opts.handle?.trim() || settings.lastHandle || '';
        if (!handle && interactive && !opts.dryRun) {
          const answer = await text({
            message: 'Public handle',
            placeholder: 'your-name',
            validate: (v) =>
              HANDLE_RE.test(v ?? '')
                ? undefined
                : 'lowercase letters, digits and dashes, up to 39',
          });
          if (isCancel(answer)) return;
          handle = answer;
        }
        if (!handle) handle = opts.dryRun ? 'you' : '';
        if (!HANDLE_RE.test(handle)) {
          throw new Error(
            handle
              ? `invalid handle "${handle}": lowercase letters, digits and dashes, up to 39`
              : 'no handle: pass --handle <handle>',
          );
        }
        const window = {
          since: opts.since,
          until: opts.until,
          tz: opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          subscription: opts.subscription,
          handle,
        };
        const site = new URL(settings.endpoint).host;
        if (opts.dryRun) {
          const p = await client.usageSharePreview(window);
          process.stdout.write(`${JSON.stringify(p.share, null, 2)}\n`);
          log.info(`${String(p.bytes)} bytes would be posted to ${p.endpoint}`);
          return;
        }
        if (interactive && !opts.yes) {
          const ok = await confirm({
            message: `Publish this window's usage as ${site}/u/${handle}? (--dry-run shows exactly what is sent)`,
          });
          if (isCancel(ok) || !ok) return;
        }
        const posted = await client.usageShare(window);
        process.stdout.write(`${posted.url}\n`);
        if (posted.claimedNow) {
          log.info(`This hub now holds the handle "${posted.handle}" on ${site}.`);
        }
      });
    },
  );

export const usageCommand = new Command('usage')
  .description(
    'Agent-hours, how many agents ran at once, and what they shipped (PRs, commits, lines), from the hub',
  )
  .enablePositionalOptions()
  .option(
    '--since <when>',
    'first day: YYYY-MM-DD, or a number of days or weeks ending at --until (30d, 2w, 365d)',
    '30d',
  )
  .option('--until <day>', 'last day, YYYY-MM-DD (default today)')
  .option(
    '--tz <zone>',
    "IANA time zone the days are in (default this machine's, e.g. Europe/Rome)",
  )
  .option('--subscription <agent/account>', 'only sessions and boxes on this subscription')
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print the whole UsageStats as JSON')
  .action(
    async (opts: {
      since: string;
      until?: string;
      tz?: string;
      subscription?: string;
      local?: boolean;
      json?: boolean;
    }) => {
      await withHubClient(opts.local ? { preferLocal: true } : {}, async (client) => {
        const stats = await client.usageStats({
          since: opts.since,
          until: opts.until,
          tz: opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          subscription: opts.subscription,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${usageHeroLines(stats).join('\n')}\n`);
      });
    },
  )
  .addCommand(tokensCommand)
  .addCommand(shareCommand);
