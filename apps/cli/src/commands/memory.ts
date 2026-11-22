/**
 * `agentbox memory ls|versions|show|pull` — the agent memory the hub keeps per
 * repo (docs/agent-history-plan.md, Phase 4). Every read goes through
 * `/api/v1/history/memory`; `pull` is the one local write, into this PC's agent
 * dir.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import type { HubApiMemoryFile, HubApiMemoryQuery } from '../control-plane/hub-api-client.js';
import { withHubClient, type WithHubOptions } from '../control-plane/with-hub.js';
import { renderTable } from '../lib/text-table.js';
import { confirm, isCancel } from '@clack/prompts';
import { repoKey } from '@agentbox/config';
import {
  backupMemoryFiles,
  gitToplevel,
  localMemoryDir,
  planPull,
  projectFolder,
  readLocalMemory,
  repoOfFolder,
  writeMemoryFile,
} from '../lib/memory-local.js';
import { shortTime } from '../lib/sessions-format.js';

interface CommonOpts {
  repo?: string;
  agent?: string;
  local?: boolean;
  json?: boolean;
}

function hubOf(opts: CommonOpts): WithHubOptions {
  return opts.local ? { preferLocal: true } : {};
}

async function queryOf(opts: CommonOpts): Promise<HubApiMemoryQuery> {
  const repo = opts.repo ?? (await repoOfFolder(await projectFolder(process.cwd())));
  if (!repo) throw new Error('no repo: run inside a git checkout or pass --repo <url>');
  return { repo, agent: opts.agent ?? 'claude' };
}

function origin(f: HubApiMemoryFile): string {
  return f.origin.boxName ?? f.origin.boxId ?? (f.origin.provider === 'host' ? 'host' : '-');
}

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`expected a positive integer, got "${raw}"`);
  return n;
}

const withCommon = (c: Command): Command =>
  c
    .option('--repo <url>', "the repo (any git URL spelling); default: this folder's origin")
    .option('--agent <id>', 'the agent (default claude)')
    .option('--local', "read this machine's hub instead of the configured one")
    .option('--json', 'print JSON');

export const memoryCommand = new Command('memory').description(
  'Agent memory the hub keeps per repo: list, versions, show, pull',
);

withCommon(
  memoryCommand
    .command('ls')
    .alias('list')
    .description("List the repo's memory files (latest version of each)")
    .option('--all-repos', 'list every repo the hub holds memory for instead'),
).action(async (opts: CommonOpts & { allRepos?: boolean }) => {
  await withHubClient(hubOf(opts), async (client) => {
    if (opts.allRepos) {
      const sets = await client.memorySets();
      if (opts.json) return void process.stdout.write(`${JSON.stringify({ sets }, null, 2)}\n`);
      if (sets.length === 0) return void log.info('The hub holds no agent memory yet.');
      renderTable(
        ['REPO', 'AGENT', 'FILES', 'VERSIONS', 'UPDATED'],
        sets.map((s) => [
          s.repoKey,
          s.agent,
          String(s.files),
          String(s.versions),
          shortTime(s.updatedAt),
        ]),
      );
      return;
    }
    const q = await queryOf(opts);
    const r = await client.memoryFiles(q);
    if (opts.json) return void process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    if (r.files.length === 0) return void log.info(`No ${r.agent} memory for ${r.repoKey}.`);
    renderTable(
      ['PATH', 'VERSION', 'BYTES', 'FROM', 'UPDATED'],
      r.files.map((f) => [
        f.path,
        String(f.version),
        String(f.size),
        origin(f),
        shortTime(f.updatedAt),
      ]),
    );
  });
});

withCommon(
  memoryCommand
    .command('versions')
    .description('Every version of one memory file, oldest first')
    .argument('<path>', 'the file, relative to the memory dir (e.g. MEMORY.md)'),
).action(async (path: string, opts: CommonOpts) => {
  await withHubClient(hubOf(opts), async (client) => {
    const versions = await client.memoryVersions(await queryOf(opts), path);
    if (opts.json)
      return void process.stdout.write(`${JSON.stringify({ path, versions }, null, 2)}\n`);
    renderTable(
      ['VERSION', 'BYTES', 'FROM', 'WHEN', 'SHA256'],
      versions.map((v) => [
        `${String(v.version)}${v.deleted ? ' (deleted)' : ''}`,
        String(v.size),
        origin(v),
        shortTime(v.updatedAt),
        v.sha256.slice(0, 12),
      ]),
    );
  });
});

withCommon(
  memoryCommand
    .command('show')
    .description('Print one memory file (default: its latest version)')
    .argument('<path>', 'the file, relative to the memory dir (e.g. MEMORY.md)')
    .option('--version <n>', 'this version instead of the latest', positiveInt),
).action(async (path: string, opts: CommonOpts & { version?: number }) => {
  await withHubClient(hubOf(opts), async (client) => {
    const { file, bytes } = await client.memoryFile(await queryOf(opts), path, opts.version);
    if (opts.json) {
      return void process.stdout.write(
        `${JSON.stringify({ file, content: bytes.toString('utf8') }, null, 2)}\n`,
      );
    }
    process.stdout.write(bytes);
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) process.stdout.write('\n');
  });
});

withCommon(
  memoryCommand
    .command('pull')
    .description(
      "Write the hub's latest memory for this repo into this PC's agent dir (shows the plan, then asks)",
    )
    .option(
      '--dir <folder>',
      'the project folder the agent keys memory by (default: this git toplevel)',
    )
    .option('--prune', 'also delete PC files the hub has deleted (never files the hub never saw)')
    .option('--dry-run', 'show the plan, write nothing')
    .option('-y, --yes', 'apply without asking (required without a terminal)'),
).action(
  async (opts: CommonOpts & { dir?: string; prune?: boolean; dryRun?: boolean; yes?: boolean }) => {
    // The folder decides where files land; never guess it outside a checkout.
    const folder = await gitToplevel(opts.dir ?? process.cwd());
    if (!folder) {
      throw new Error(
        `${opts.dir ?? process.cwd()} is not a git checkout: run inside the project, or pass --dir <folder>`,
      );
    }
    const folderRepo = await repoOfFolder(folder);
    if (opts.repo && !opts.dir) {
      const asked = opts.repo.startsWith('local:') ? opts.repo : repoKey(opts.repo);
      if (asked !== folderRepo) {
        throw new Error(
          `--repo ${opts.repo} is not this folder's repo (${folderRepo ?? 'none'}); ` +
            "pass --dir <folder> to choose which project's memory dir it writes",
        );
      }
    }
    const repo = opts.repo ?? folderRepo;
    if (!repo) throw new Error('no repo: this checkout has no origin; pass --repo <url>');
    const q: HubApiMemoryQuery = { repo, agent: opts.agent ?? 'claude' };
    const agent = q.agent ?? 'claude';
    const dir = localMemoryDir(agent, folder);
    await withHubClient(hubOf(opts), async (client) => {
      const { files } = await client.memoryFiles(q, { includeDeleted: true });
      const plan = await planPull(
        files,
        await readLocalMemory(dir),
        async (path, version) => (await client.memoryFile(q, path, version)).bytes,
      );
      const writes = plan.filter((e) => e.action === 'add' || e.action === 'update');
      const deletes = opts.prune ? plan.filter((e) => e.action === 'delete') : [];
      const changes = writes.length + deletes.length;

      if (!opts.json) {
        process.stdout.write(`${dir}\n`);
        for (const e of plan) {
          if (e.action === 'same') continue;
          const note =
            e.action === 'delete'
              ? opts.prune
                ? ''
                : '  (deleted on the hub; --prune removes it)'
              : e.action === 'local'
                ? '  (only on this PC; left alone)'
                : ` (hub v${String(e.version)})`;
          const verb = e.action === 'local' ? 'keep' : e.action;
          process.stdout.write(`  ${verb.padEnd(7)}${e.path}${note}\n`);
        }
      }
      const summary = {
        dir,
        repo: q.repo,
        agent,
        files: plan.map((e) => ({ path: e.path, action: e.action, version: e.version })),
      };
      if (changes === 0) {
        if (opts.json)
          process.stdout.write(`${JSON.stringify({ ...summary, applied: false }, null, 2)}\n`);
        else log.info('Already current: nothing to write.');
        return;
      }
      if (opts.dryRun) {
        if (opts.json)
          process.stdout.write(`${JSON.stringify({ ...summary, applied: false }, null, 2)}\n`);
        else
          log.info(
            `Dry run: would write ${String(writes.length)}, delete ${String(deletes.length)}.`,
          );
        return;
      }
      // These files are written by box agents and loaded into this PC's agent
      // context: a person reviews the plan, or says -y up front.
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY || opts.json) {
          throw new Error('refusing to change local memory without confirmation: re-run with -y');
        }
        const ok = await confirm({
          message: `Write ${String(writes.length)} and delete ${String(deletes.length)} file(s) in ${dir}?`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          log.info('Nothing changed.');
          return;
        }
      }
      const backup = await backupMemoryFiles(
        dir,
        [...writes.filter((e) => e.action === 'update'), ...deletes].map((e) => e.path),
        agent,
      );
      for (const w of writes) await writeMemoryFile(dir, w.path, w.bytes!);
      for (const d of deletes) await rm(join(dir, d.path), { force: true });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...summary, applied: true, backup }, null, 2)}\n`);
        return;
      }
      log.info(
        `Wrote ${String(writes.length)}, deleted ${String(deletes.length)}.` +
          (backup ? ` Previous copies: ${backup}` : ''),
      );
    });
  },
);
