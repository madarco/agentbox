import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { destroyBoxes } from './lib/box.js';
import {
  AGENTBOX_BIN,
  E2E_HOME,
  E2E_HUB_PORT,
  REPO_ROOT,
  RUNS_DIR,
  assertIsolatedHome,
  killStaleHub,
} from './lib/env.js';
import { ab, poll } from './lib/exec.js';
import { cleanupGithub, setTestRepo } from './lib/github.js';
import { bootstrapHome } from './lib/home.js';
import { buildTarball, installTarball, latestTarball } from './lib/pack.js';
import { isGreen, writeSummary, type RunSummary } from './lib/report.js';
import {
  Budget,
  progress,
  runScenario,
  setProgressLog,
  type RunOptions,
  type ScenarioResult,
} from './lib/runner.js';
import { findLeaks, removeLeaks } from './lib/sweep.js';
import { parseTargets, type Target } from './lib/targets.js';
import { runLinuxTarget, prepareLinuxSsh } from './lib/linux.js';
import { SCENARIOS } from './scenarios/index.js';

const HELP = `pnpm e2e [options]   — pre-release e2e run (docs/release-e2e-plan.md)

  --targets <list>     docker@mac,docker@linux,remote-docker,daytona,hetzner,vercel,e2b | all
                       (default docker@mac)
  --scenarios <list>   s1..s8 (default all)
  --reuse-bake         keep the previous run's bakes; S1 checks them instead of re-baking
  --no-build           reuse the last packed tarball instead of rebuilding
  --tarball <path>     install this tarball (implies --no-build)
  --keep               leave boxes, branches and the hub running for inspection
  --no-judge           skip the AI judge (its steps still capture evidence)
  --no-tray            skip the macOS tray steps
  --repo <owner/name>  GitHub test repo (default madarco/agentbox-test-repo)
  --run-id <id>        reuse a run id (default: generated)
  --worker             internal: run targets only, no pack/sweep (used on the Linux VM)
`;

function runIdNow(): string {
  return Date.now().toString(36).slice(-5);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** codex + opencode run on docker and on one cloud per run, rotating by day. */
function agentsFor(t: Target): string[] {
  const clouds = ['daytona', 'hetzner', 'vercel', 'e2b'];
  const rotating = clouds[Math.floor(Date.now() / 86_400_000) % clouds.length];
  return t.id === 'docker@mac' || t.provider === rotating
    ? ['claude', 'codex', 'opencode']
    : ['claude'];
}

async function startHub(log: string): Promise<void> {
  await ab(['hub', 'start', '--no-open'], { log, timeoutMs: 120_000 });
  await poll(
    'e2e hub /healthz',
    async () => (await fetch(`http://127.0.0.1:${String(E2E_HUB_PORT)}/healthz`)).ok,
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
}

async function runTarget(
  t: Target,
  scenarioIds: string[],
  opts: RunOptions,
): Promise<ScenarioResult[]> {
  const budget = new Budget(t.maxBoxes);
  const defs = SCENARIOS.filter((s) => scenarioIds.includes(s.id));
  const results: ScenarioResult[] = [];
  const s1 = defs.find((d) => d.id === 's1');
  if (s1) {
    const r = await runScenario(s1, t, opts);
    results.push(r);
    const bakeFailed = r.steps.some(
      (st) => st.name === 'bake the base image' && st.status === 'fail',
    );
    if (bakeFailed) {
      for (const d of defs.filter((x) => x.id !== 's1')) {
        results.push({
          id: d.id,
          title: d.title,
          target: t.id,
          status: 'skip',
          skipReason: 'the S1 bake failed on this target',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          steps: [],
        });
      }
      return results;
    }
  }
  const rest = await Promise.all(
    defs
      .filter((d) => d.id !== 's1')
      .map(async (d) => {
        const release = await budget.take(d.boxes);
        try {
          return await runScenario(d, t, opts);
        } finally {
          release();
        }
      }),
  );
  return [...results, ...rest];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      targets: { type: 'string', default: 'docker@mac' },
      scenarios: { type: 'string', default: SCENARIOS.map((s) => s.id).join(',') },
      'reuse-bake': { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      tarball: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'no-judge': { type: 'boolean', default: false },
      'no-tray': { type: 'boolean', default: false },
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      worker: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  assertIsolatedHome();
  if (values.repo) setTestRepo(values.repo);

  const targets = parseTargets(values.targets);
  const scenarioIds = values.scenarios.split(',').map((s) => s.trim().toLowerCase());
  for (const id of scenarioIds) {
    if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`unknown scenario ${id}`);
  }
  const runId = values['run-id'] ?? runIdNow();
  const sha = git(['rev-parse', 'HEAD']);
  const runDir = join(RUNS_DIR, `${sha.slice(0, 10) || 'nosha'}-${runId}`);
  mkdirSync(runDir, { recursive: true });
  setProgressLog(join(runDir, 'progress.log'));
  const setupLog = join(runDir, 'setup.log');
  const startedAt = new Date().toISOString();
  progress(
    `run ${runId}: targets ${targets.map((t) => t.id).join(', ')}; scenarios ${scenarioIds.join(', ')}`,
  );
  progress(`report: ${join(runDir, 'report.html')}`);

  // A worker (the Linux VM) runs every target it is given; the Mac ships linux targets to it.
  const localTargets = values.worker ? targets : targets.filter((t) => t.host === 'mac');
  const linuxTargets = values.worker ? [] : targets.filter((t) => t.host === 'linux');

  let tarball = values.tarball;
  let cliVersion = '';
  if (!values.worker) {
    if (!tarball) tarball = values['no-build'] ? latestTarball() : await buildTarball(setupLog);
  }
  if (tarball) cliVersion = await installTarball(tarball, setupLog);
  else cliVersion = execFileSync(AGENTBOX_BIN, ['--version'], { encoding: 'utf8' }).trim();

  // A hub left over from an earlier run holds the old home's files open.
  await ab(['hub', 'stop'], { log: setupLog, allowFail: true, timeoutMs: 60_000 });
  killStaleHub(E2E_HUB_PORT, E2E_HOME);
  bootstrapHome({ reuseBake: values['reuse-bake'] });
  if (targets.some((t) => t.id === 'remote-docker')) prepareLinuxSsh();
  await startHub(setupLog);

  const opts: RunOptions = {
    runId,
    runDir,
    keep: values.keep,
    judge: !values['no-judge'],
    reuseBake: values['reuse-bake'],
    tray: !values['no-tray'] && process.platform === 'darwin',
    agentsFor,
    cleanup: async (ctx) => destroyBoxes(ctx, ctx.tracked),
  };

  const [local, remote] = await Promise.all([
    Promise.all(localTargets.map((t) => runTarget(t, scenarioIds, opts))).then((r) => r.flat()),
    linuxTargets.length && !values.worker && tarball
      ? runLinuxTarget({
          runId,
          runDir,
          tarball,
          scenarios: scenarioIds,
          keep: values.keep,
          judge: opts.judge,
        })
      : Promise.resolve([] as ScenarioResult[]),
  ]);
  const results = [...local, ...remote];

  const sweep: RunSummary['sweep'] = [];
  const sweepLog = join(runDir, 'sweep.log');
  if (!values.keep) {
    progress('sweep: leftovers');
    for (const t of localTargets) {
      try {
        const leaks = await findLeaks(t, runId, sweepLog);
        const left = await removeLeaks(t, leaks, sweepLog);
        sweep.push({
          target: t.id,
          leaks: leaks.map(
            (l) => `${l.kind} ${l.name}${left.includes(l) ? ' (NOT removed)' : ' (removed)'}`,
          ),
        });
      } catch (err) {
        sweep.push({
          target: t.id,
          leaks: [`sweep failed: ${err instanceof Error ? err.message : String(err)}`],
        });
      }
    }
    if (!values.worker) {
      try {
        const removed = await cleanupGithub(runId, sweepLog);
        progress(`sweep: deleted ${String(removed.length)} GitHub branches`);
      } catch (err) {
        progress(
          `sweep: GitHub cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await ab(['hub', 'stop'], { log: sweepLog, allowFail: true });
  }

  const summary: RunSummary = {
    runId,
    sha,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    cliVersion,
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: targets.map((t) => t.id),
    scenarios: scenarioIds,
    ok: isGreen(results) && sweep.every((s) => s.leaks.length === 0),
    results,
    sweep,
    findings: [],
  };
  writeSummary(runDir, summary);
  writeFileSync(join(RUNS_DIR, 'latest'), `${runDir}\n`);
  progress(`${summary.ok ? 'GREEN' : 'RED'} — ${join(runDir, 'report.html')}`);
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `e2e: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(2);
  },
);
