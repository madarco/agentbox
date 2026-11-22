/**
 * `agentbox sessions ls|show|search|download` — read the hub's session history
 * (docs/agent-history-plan.md, Phase 2). Every call goes through `/api/v1`; the
 * CLI reads no store of its own.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient, type WithHubOptions } from '../control-plane/with-hub.js';
import { renderTable } from '../lib/text-table.js';
import { saveStreamAtomically } from '../lib/sessions-download.js';
import {
  SESSION_HEADERS,
  clip,
  downloadTarget,
  sessionRow,
  shortId,
  shortTime,
  turnLine,
} from '../lib/sessions-format.js';

interface HubOpt {
  local?: boolean;
}

/** The configured hub (where box history lands), or this machine's with `--local`. */
function hubOf(opts: HubOpt): WithHubOptions {
  return opts.local ? { preferLocal: true } : {};
}

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`expected a positive integer, got "${raw}"`);
  return n;
}

export const sessionsCommand = new Command('sessions').description(
  'Agent sessions recorded by the hub: list, show, search and download transcripts',
);

sessionsCommand
  .command('ls')
  .alias('list')
  .description('List recorded sessions, newest activity first')
  .option('--agent <id>', 'only this agent (e.g. claude)')
  .option('--box <ref>', 'only sessions of this box (id or name)')
  .option('--project <text>', 'only projects whose repo URL contains this')
  .option('--host <machineId>', 'only sessions shipped by this PC')
  .option('--since <iso>', 'only sessions active at or after this time (ISO-8601)')
  .option('-q, --query <words>', 'only sessions whose turns contain all these words')
  .option('-n, --limit <n>', 'at most this many (default 50, max 500)', positiveInt)
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print JSON')
  .action(
    async (
      opts: {
        agent?: string;
        box?: string;
        project?: string;
        host?: string;
        since?: string;
        query?: string;
        limit?: number;
        json?: boolean;
      } & HubOpt,
    ) => {
      await withHubClient(hubOf(opts), async (client) => {
        const sessions = await client.listHistorySessions({
          agent: opts.agent,
          box: opts.box,
          project: opts.project,
          host: opts.host,
          since: opts.since,
          q: opts.query,
          limit: opts.limit,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ sessions }, null, 2)}\n`);
          return;
        }
        if (sessions.length === 0) {
          log.info('No recorded sessions match.');
          return;
        }
        renderTable(SESSION_HEADERS, sessions.map(sessionRow));
      });
    },
  );

sessionsCommand
  .command('show')
  .description('Show one session: its box, files, tools and a condensed transcript')
  .argument('<session>', 'session id, an id prefix (8+ chars), or <agent>:<id>')
  .option('--turns <n>', 'show the first N transcript rows (default 40)', positiveInt)
  .option('--all', 'show every transcript row')
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print JSON (the detail plus the rows shown)')
  .action(async (ref: string, opts: { turns?: number; all?: boolean; json?: boolean } & HubOpt) => {
    await withHubClient(hubOf(opts), async (client) => {
      const d = await client.historySession(ref);
      const want = opts.all ? d.turns : Math.min(opts.turns ?? 40, d.turns);
      const turns = [];
      for (let from = 0; from < want; from += 1000) {
        turns.push(
          ...(await client.historyTurns(d.session.key, from, Math.min(want, from + 1000) - 1)),
        );
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...d, rows: turns }, null, 2)}\n`);
        return;
      }
      const s = d.session;
      const lines = [
        `session   ${s.id} (${s.agent})${s.title ? ` — ${clip(s.title, 80)}` : ''}`,
        `box       ${s.boxName ?? '-'} (${s.boxId ?? '-'}) on ${s.provider ?? '-'}`,
        ...(s.projectRepoUrl ? [`project   ${s.projectRepoUrl}`] : []),
        ...(s.parentSessionId ? [`parent    ${s.parentSessionId}`] : []),
        `active    ${shortTime(s.firstTs)} → ${shortTime(s.lastTs)}`,
        `turns     ${String(d.turns)} rows, tokens ${String(s.inputTokens)} in / ${String(s.outputTokens)} out`,
        `files     ${d.files.map((f) => `${f.path} (${String(f.bytes)} B)`).join('\n          ')}`,
      ];
      if (d.tools.length > 0) {
        lines.push(`tools     ${d.tools.map((t) => `${t.name} ×${String(t.count)}`).join(', ')}`);
      }
      process.stdout.write(`${lines.join('\n')}\n\n`);
      for (const t of turns) process.stdout.write(`${turnLine(t)}\n`);
      if (want < d.turns) {
        process.stdout.write(
          `\n… ${String(d.turns - want)} more row(s): --all, or \`agentbox sessions download ${shortId(s.id)}\`\n`,
        );
      }
    });
  });

sessionsCommand
  .command('search')
  .description('Full-text search across every recorded turn')
  .argument('<words...>', 'words that must all appear in a turn')
  .option('-n, --limit <n>', 'at most this many hits (default 20, max 200)', positiveInt)
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print JSON')
  .action(async (words: string[], opts: { limit?: number; json?: boolean } & HubOpt) => {
    await withHubClient(hubOf(opts), async (client) => {
      const hits = await client.searchHistory(words.join(' '), opts.limit ?? 20);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ hits }, null, 2)}\n`);
        return;
      }
      if (hits.length === 0) {
        log.info('No turn matches.');
        return;
      }
      renderTable(
        ['ID', 'BOX', 'WHO', 'WHEN', 'MATCH'],
        hits.map((h) => [
          shortId(h.session.id ?? h.session.key ?? ''),
          h.session.boxName ?? '-',
          h.role ?? '-',
          shortTime(h.ts),
          clip(h.snippet, 100),
        ]),
      );
    });
  });

sessionsCommand
  .command('download')
  .description("Download a session's transcript files (main + subagents) byte for byte")
  .argument('<session>', 'session id, an id prefix (8+ chars), or <agent>:<id>')
  .option('-o, --out <dir>', 'parent folder; files land in <dir>/<sessionId>/', '.')
  .option('--local', "read this machine's hub instead of the configured one")
  .option('--json', 'print what was written as JSON')
  .action(async (ref: string, opts: { out: string; json?: boolean } & HubOpt) => {
    await withHubClient(hubOf(opts), async (client) => {
      const d = await client.historySession(ref);
      const written: Array<{ path: string; file: string; bytes: number }> = [];
      for (const f of d.files) {
        const target = downloadTarget(opts.out, d.session.id, f.path);
        if (!target) {
          log.warn(`skipped ${f.path}: it would land outside the download folder`);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        const body = await client.historyRaw(d.session.key, f.path);
        // What arrived, not the size the detail call saw: a live session grows.
        const bytes = await saveStreamAtomically(body, target);
        written.push({ path: f.path, file: target, bytes });
      }
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ session: d.session.id, files: written }, null, 2)}\n`,
        );
        return;
      }
      for (const w of written) process.stdout.write(`${w.file}  (${String(w.bytes)} B)\n`);
    });
  });
