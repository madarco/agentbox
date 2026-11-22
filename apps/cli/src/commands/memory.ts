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
import {
  localMemoryDir,
  projectFolder,
  readLocalMemory,
  repoOfFolder,
  writeMemoryFile,
  type PullPlanEntry,
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
    .description("Write the hub's latest memory for this repo into this PC's agent dir")
    .option(
      '--dir <folder>',
      'the project folder the agent keys memory by (default: this git toplevel)',
    )
    .option('--prune', 'also delete local memory files the hub does not have')
    .option('--dry-run', 'show what would change, write nothing'),
).action(async (opts: CommonOpts & { dir?: string; prune?: boolean; dryRun?: boolean }) => {
  const folder = await projectFolder(opts.dir ?? process.cwd());
  const q = await queryOf({ ...opts, repo: opts.repo ?? (await repoOfFolder(folder)) });
  const agent = q.agent ?? 'claude';
  const dir = localMemoryDir(agent, folder);
  await withHubClient(hubOf(opts), async (client) => {
    const { files } = await client.memoryFiles(q);
    const local = await readLocalMemory(dir);
    const plan: PullPlanEntry[] = [];
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    for (const f of files) {
      const { bytes } = await client.memoryFile(q, f.path, f.version);
      const have = local.get(f.path);
      const action = !have ? 'add' : have.equals(bytes) ? 'same' : 'update';
      plan.push({ path: f.path, action, version: f.version });
      if (action !== 'same') writes.push({ path: f.path, bytes });
    }
    const hubPaths = new Set(files.map((f) => f.path));
    const localOnly = [...local.keys()].filter((p) => !hubPaths.has(p));
    if (!opts.dryRun) {
      for (const w of writes) await writeMemoryFile(dir, w.path, w.bytes);
      if (opts.prune) for (const p of localOnly) await rm(join(dir, p), { force: true });
    }
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ dir, repo: q.repo, agent, dryRun: !!opts.dryRun, files: plan, localOnly, pruned: !opts.dryRun && !!opts.prune }, null, 2)}\n`,
      );
      return;
    }
    const verb = opts.dryRun ? 'would' : 'did';
    for (const p of plan)
      if (p.action !== 'same')
        process.stdout.write(`${p.action.padEnd(7)}${p.path} (v${String(p.version)})\n`);
    for (const p of localOnly) {
      process.stdout.write(
        `${opts.prune ? 'delete ' : 'local  '}${p}${opts.prune ? '' : ' (not on the hub; --prune deletes it)'}\n`,
      );
    }
    const changed = plan.filter((p) => p.action !== 'same').length;
    log.info(
      `${dir}: ${verb} write ${String(changed)} file(s), ${String(plan.length - changed)} already current` +
        (opts.prune && localOnly.length > 0 ? `, ${verb} delete ${String(localOnly.length)}` : ''),
    );
  });
});
