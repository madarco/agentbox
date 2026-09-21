import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Target } from './targets.js';

export type StepStatus = 'pass' | 'fail' | 'skip' | 'expected-fail';

export interface Judgement {
  pass: boolean;
  reason: string;
  expectation: string;
  evidence?: string;
}

export interface StepResult {
  name: string;
  kind: 'step' | 'edge';
  status: StepStatus;
  durationMs: number;
  covers: string[];
  note?: string;
  error?: string;
  log: string;
  evidence: string[];
  judgements: Judgement[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  target: string;
  status: StepStatus;
  skipReason?: string;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
}

export interface RunOptions {
  runId: string;
  runDir: string;
  keep: boolean;
  judge: boolean;
  /** Reuse the previous run's bakes instead of forcing new ones (S1). */
  reuseBake: boolean;
  tray: boolean;
  /** Agents S2 runs on this target (claude everywhere, codex/opencode rotated). */
  agentsFor: (t: Target) => string[];
  /** Runs after every scenario's own teardown: destroys the boxes it tracked. */
  cleanup: (ctx: Ctx) => Promise<void>;
}

export interface Ctx {
  target: Target;
  scenario: string;
  opts: RunOptions;
  /** Scenario working dir under the run dir. */
  dir: string;
  /** Log of the step being run; every command appends here. */
  log: string;
  /** State shared between the steps of one scenario. */
  vars: Record<string, unknown>;
  /** `e2e-<run>-<target>-<scenario><suffix>`; short because cloud names are length-limited. */
  box: (suffix?: string) => string;
  /** Boxes the teardown destroys (the final sweep catches anything missed). */
  trackBox: (name: string) => void;
  tracked: Set<string>;
  evidence: (path: string) => void;
  note: (text: string) => void;
  judgements: Judgement[];
}

export interface StepDef {
  name: string;
  covers?: string[];
  /** Edge cases only run when every step they name passed. Flow steps need all earlier steps. */
  needs?: string[];
  /**
   * Steps in a named group depend only on the ungrouped steps before them and on
   * their own group, so one agent's failure doesn't skip another agent's flow.
   */
  group?: string;
  /** Known product gap: a failure reports `expected-fail`, not `fail`. */
  expectedFail?: string;
  /** Return a reason string to skip this step on a target. */
  skipOn?: (t: Target, opts: RunOptions) => string | undefined;
  fn: (ctx: Ctx) => Promise<void>;
}

export interface ScenarioDef {
  id: string;
  title: string;
  covers: string[];
  /** Concurrent boxes this scenario holds; gates it on the target's box budget. */
  boxes: number;
  /** Return a reason string when the scenario doesn't apply to a target. */
  skipOn?: (t: Target, opts: RunOptions) => string | undefined;
  steps: StepDef[] | ((t: Target, opts: RunOptions) => StepDef[]);
  edges?: StepDef[] | ((t: Target, opts: RunOptions) => StepDef[]);
  teardown?: (ctx: Ctx) => Promise<void>;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function runScenario(
  def: ScenarioDef,
  target: Target,
  opts: RunOptions,
): Promise<ScenarioResult> {
  const startedAt = new Date();
  const dir = join(opts.runDir, target.id, def.id);
  mkdirSync(dir, { recursive: true });
  const result: ScenarioResult = {
    id: def.id,
    title: def.title,
    target: target.id,
    status: 'pass',
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    steps: [],
  };

  const skip = def.skipOn?.(target, opts);
  if (skip) {
    result.status = 'skip';
    result.skipReason = skip;
    return result;
  }

  const tracked = new Set<string>();
  const ctx: Ctx = {
    target,
    scenario: def.id,
    opts,
    dir,
    log: join(dir, 'scenario.log'),
    vars: {},
    box: (suffix = '') => `e2e-${opts.runId}-${target.slug}-${def.id}${suffix}`,
    trackBox: (name) => tracked.add(name),
    tracked,
    evidence: () => undefined,
    note: () => undefined,
    judgements: [],
  };

  const passed = new Set<string>();
  // group ('' = ungrouped) -> the step that broke it
  const broken = new Map<string, string>();
  let index = 0;

  const runStep = async (step: StepDef, kind: 'step' | 'edge'): Promise<void> => {
    index += 1;
    const log = join(dir, `${String(index).padStart(2, '0')}-${slug(step.name)}.log`);
    const res: StepResult = {
      name: step.name,
      kind,
      status: 'pass',
      durationMs: 0,
      covers: step.covers ?? [],
      log: relative(opts.runDir, log),
      evidence: [],
      judgements: [],
    };
    result.steps.push(res);
    writeFileSync(log, `# ${target.id} ${def.id}: ${step.name}\n`);

    let skipReason = step.skipOn?.(target, opts);
    if (!skipReason && kind === 'step') {
      const at = broken.get('') ?? (step.group ? broken.get(step.group) : undefined);
      if (at) skipReason = `flow stopped at "${at}"`;
    }
    if (!skipReason && kind === 'edge') {
      const missing = (step.needs ?? []).find((n) => !passed.has(n));
      if (missing) skipReason = `needs "${missing}"`;
    }
    if (skipReason) {
      res.status = 'skip';
      res.note = skipReason;
      return;
    }

    const notes: string[] = [];
    ctx.log = log;
    ctx.evidence = (p) => res.evidence.push(relative(opts.runDir, p));
    ctx.note = (t) => notes.push(t);
    ctx.judgements = res.judgements;
    const started = Date.now();
    progress(`${target.id} ${def.id} > ${step.name}`);
    try {
      await step.fn(ctx);
      const failedJudge = res.judgements.find((j) => !j.pass);
      if (failedJudge) throw new Error(`judge: ${failedJudge.reason}`);
      res.status = 'pass';
      if (step.expectedFail)
        notes.push(`passed although marked expected-fail (${step.expectedFail})`);
      passed.add(step.name);
    } catch (err) {
      res.error = errorText(err);
      appendFileSync(log, `\n!! ${res.error}\n`);
      if (step.expectedFail) {
        res.status = 'expected-fail';
        notes.push(step.expectedFail);
      } else {
        res.status = 'fail';
        if (kind === 'step') broken.set(step.group ?? '', step.name);
      }
    } finally {
      res.durationMs = Date.now() - started;
      if (notes.length > 0) res.note = notes.join('; ');
      progress(
        `${target.id} ${def.id} < ${step.name}: ${res.status.toUpperCase()} (${String(Math.round(res.durationMs / 1000))}s)`,
      );
    }
  };

  const steps = typeof def.steps === 'function' ? def.steps(target, opts) : def.steps;
  const edges = typeof def.edges === 'function' ? def.edges(target, opts) : (def.edges ?? []);
  for (const step of steps) await runStep(step, 'step');
  for (const edge of edges) await runStep(edge, 'edge');

  if (!opts.keep) {
    ctx.log = join(dir, 'teardown.log');
    for (const fn of [def.teardown, opts.cleanup]) {
      if (!fn) continue;
      try {
        await fn(ctx);
      } catch (err) {
        appendFileSync(ctx.log, `\n!! teardown: ${errorText(err)}\n`);
      }
    }
  }

  result.durationMs = Date.now() - startedAt.getTime();
  const statuses = result.steps.map((s) => s.status);
  result.status = statuses.includes('fail') ? 'fail' : 'pass';
  return result;
}

let progressLog: string | undefined;
export function setProgressLog(path: string): void {
  progressLog = path;
}
export function progress(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  process.stdout.write(`${line}\n`);
  if (progressLog) appendFileSync(progressLog, `${line}\n`);
}

/** Counting semaphore: a target's box budget shared by its concurrent scenarios. */
export class Budget {
  private free: number;
  private waiters: Array<() => void> = [];
  constructor(private readonly size: number) {
    this.free = size;
  }
  async take(n: number): Promise<() => void> {
    const need = Math.min(n, this.size);
    while (this.free < need) await new Promise<void>((r) => this.waiters.push(r));
    this.free -= need;
    return () => {
      this.free += need;
      const ws = this.waiters.splice(0);
      for (const w of ws) w();
    };
  }
}
