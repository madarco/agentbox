import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/supervisor.js';
import type { CtlConfig, TaskSpec } from '../src/config.js';

function taskCfg(task: TaskSpec): CtlConfig {
  return { services: [], tasks: [task], replacements: {} };
}

async function waitForTaskDone(sup: Supervisor, name: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = sup.listTasks().find((x) => x.name === name);
    if (t && (t.state === 'done' || t.state === 'failed')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${name} did not finish`);
}

function lineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0).length;
}

describe('idempotent tasks', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctl-idem-'));
    stateDir = join(dir, 'state');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mk = () => new Supervisor({ workspace: dir, logDir: dir, stateDir });

  it('marker form: skips on a warm boot, leaving the command unrun', async () => {
    const ran = join(dir, 'ran');
    const task = { name: 't', command: `: > '${ran}'`, needs: [], idempotent: { kind: 'marker' } as const };

    const sup1 = mk();
    await sup1.init(taskCfg(task));
    await waitForTaskDone(sup1, 't');
    expect(existsSync(ran)).toBe(true);
    await sup1.stopAll();

    // Remove the side-effect file; a second boot must NOT recreate it (skipped).
    await rm(ran);
    const sup2 = mk();
    await sup2.init(taskCfg(task));
    await waitForTaskDone(sup2, 't');
    expect(existsSync(ran)).toBe(false);
    await sup2.stopAll();
  });

  it('marker form: re-runs when the command changes', async () => {
    const sup1 = mk();
    await sup1.init(
      taskCfg({ name: 't', command: 'true', needs: [], idempotent: { kind: 'marker' } }),
    );
    await waitForTaskDone(sup1, 't');
    await sup1.stopAll();

    const ran2 = join(dir, 'ran2');
    const sup2 = mk();
    await sup2.init(
      taskCfg({ name: 't', command: `: > '${ran2}'`, needs: [], idempotent: { kind: 'marker' } }),
    );
    await waitForTaskDone(sup2, 't');
    expect(existsSync(ran2)).toBe(true); // changed command invalidated the marker
    await sup2.stopAll();
  });

  it('check form: skips when the probe exits 0, runs when it fails', async () => {
    const satisfied = join(dir, 'satisfied');
    const runs = join(dir, 'runs');
    const task = {
      name: 't',
      command: `echo x >> '${runs}'`,
      needs: [],
      idempotent: { kind: 'check', command: `test -f '${satisfied}'` } as const,
    };

    // Probe fails (no satisfied file) → task runs.
    const sup1 = mk();
    await sup1.init(taskCfg(task));
    await waitForTaskDone(sup1, 't');
    expect(lineCount(runs)).toBe(1);
    await sup1.stopAll();

    // Probe now passes → task skips (runs file unchanged). No marker is written.
    await import('node:fs/promises').then((fs) => fs.writeFile(satisfied, ''));
    expect(existsSync(join(stateDir, 'tasks', 't'))).toBe(false);
    const sup2 = mk();
    await sup2.init(taskCfg(task));
    await waitForTaskDone(sup2, 't');
    expect(lineCount(runs)).toBe(1);
    await sup2.stopAll();
  });

  it('run-task --force bypasses the marker and re-runs', async () => {
    const runs = join(dir, 'runs');
    const task = {
      name: 't',
      command: `echo x >> '${runs}'`,
      needs: [],
      idempotent: { kind: 'marker' } as const,
    };
    const sup = mk();
    await sup.init(taskCfg(task));
    await waitForTaskDone(sup, 't');
    expect(lineCount(runs)).toBe(1);

    await sup.runTask('t', true);
    const start = Date.now();
    while (lineCount(runs) < 2 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lineCount(runs)).toBe(2);
    await sup.stopAll();
  });
});
