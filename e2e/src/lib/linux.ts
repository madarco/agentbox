import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { E2E_HOME, REAL_HOME, REPO_ROOT } from './env.js';
import { run } from './exec.js';
import { progress, type ScenarioResult } from './runner.js';
import { LINUX_VM_ALIAS } from './targets.js';

const VM_STATE = join(REAL_HOME, '.agentbox', 'hub-test-vm', 'state.json');
const VM_KEY = join(REAL_HOME, '.agentbox', 'hub-test-vm', 'id_ed25519');

function vmIp(): string {
  if (!existsSync(VM_STATE))
    throw new Error('no Linux test VM; run `scripts/hub-test-vm.sh up` first');
  const { ip } = JSON.parse(readFileSync(VM_STATE, 'utf8')) as { ip?: string };
  if (!ip) throw new Error(`${VM_STATE} has no ip`);
  return ip;
}

/**
 * Give the e2e home an ssh alias for the Linux VM. remote-docker reaches its host
 * through the user's own ~/.ssh/config, which under the e2e HOME is this one.
 */
export function prepareLinuxSsh(): void {
  const dir = join(E2E_HOME, '.ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'config'),
    [
      `Host ${LINUX_VM_ALIAS}`,
      `  HostName ${vmIp()}`,
      '  User dev',
      `  IdentityFile ${VM_KEY}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking accept-new',
      `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

/**
 * Run the docker@linux target on the Hetzner test VM: ship the harness source and the
 * tarball, run it as a `--worker`, copy its run dir back and return its results.
 */
export async function runLinuxTarget(o: {
  runId: string;
  runDir: string;
  tarball: string;
  scenarios: string[];
  keep: boolean;
  judge: boolean;
}): Promise<ScenarioResult[]> {
  prepareLinuxSsh();
  const log = join(o.runDir, 'linux-worker.log');
  const ssh = (cmd: string, timeoutMs = 600_000) =>
    run('ssh', ['-F', join(E2E_HOME, '.ssh', 'config'), LINUX_VM_ALIAS, cmd], { log, timeoutMs });
  const scp = (args: string[]) =>
    run('scp', ['-F', join(E2E_HOME, '.ssh', 'config'), '-q', ...args], {
      log,
      timeoutMs: 600_000,
    });
  const rsync = (args: string[]) =>
    run('rsync', ['-az', '-e', `ssh -F ${join(E2E_HOME, '.ssh', 'config')}`, ...args], {
      log,
      timeoutMs: 600_000,
    });

  progress('docker@linux: shipping the harness to the VM');
  await ssh('mkdir -p ~/e2e-src/e2e ~/e2e-pack && rm -f ~/e2e-pack/*.tgz');
  await rsync([
    '--delete',
    '--exclude',
    'node_modules',
    '--exclude',
    'runs',
    '--exclude',
    'tray-driver',
    `${join(REPO_ROOT, 'e2e')}/`,
    `${LINUX_VM_ALIAS}:e2e-src/e2e/`,
  ]);
  await scp([join(REPO_ROOT, 'tsconfig.base.json'), `${LINUX_VM_ALIAS}:e2e-src/`]);
  await scp([o.tarball, `${LINUX_VM_ALIAS}:e2e-pack/`]);
  await ssh(
    'cd ~/e2e-src/e2e && npm install --no-fund --no-audit --silent && npm install --no-save --silent tsx',
    900_000,
  );

  progress('docker@linux: running the worker on the VM');
  const worker = [
    'cd ~/e2e-src/e2e &&',
    'npx tsx src/cli.ts --worker --targets docker@linux',
    `--scenarios ${o.scenarios.join(',')}`,
    `--run-id ${o.runId}`,
    `--tarball ~/e2e-pack/${basename(o.tarball)}`,
    '--no-tray',
    o.keep ? '--keep' : '',
    o.judge ? '' : '--no-judge',
  ].join(' ');
  const r = await run('ssh', ['-F', join(E2E_HOME, '.ssh', 'config'), LINUX_VM_ALIAS, worker], {
    log,
    timeoutMs: 4 * 60 * 60_000,
    allowFail: true,
  });
  progress(`docker@linux: worker exited ${String(r.exitCode)}`);

  const local = join(o.runDir, 'docker@linux');
  mkdirSync(local, { recursive: true });
  await rsync([`${LINUX_VM_ALIAS}:e2e-src/e2e/runs/nosha-${o.runId}/`, `${local}/`]).catch(
    () => undefined,
  );
  const summary = join(local, 'summary.json');
  if (!existsSync(summary)) {
    return [
      {
        id: 'worker',
        title: 'Linux worker',
        target: 'docker@linux',
        status: 'fail',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        steps: [
          {
            name: 'run the harness on the Linux VM',
            kind: 'step',
            status: 'fail',
            durationMs: 0,
            covers: [],
            error: `worker exited ${String(r.exitCode)} without a summary; see linux-worker.log`,
            log: 'linux-worker.log',
            evidence: [],
            judgements: [],
          },
        ],
      },
    ];
  }
  const s = JSON.parse(readFileSync(summary, 'utf8')) as { results: ScenarioResult[] };
  // Step logs live under docker@linux/docker@linux/<scenario>/ once copied back; rebase their paths.
  for (const res of s.results) {
    for (const st of res.steps) {
      st.log = join('docker@linux', st.log);
      st.evidence = st.evidence.map((e) => join('docker@linux', e));
    }
  }
  return s.results;
}
