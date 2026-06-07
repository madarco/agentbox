import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { parseReplacements, type ReplaceRule } from './replace.js';

export type RestartPolicy = 'always' | 'on-failure' | 'never';
export type ProbeOnTimeout = 'kill' | 'mark_unhealthy';

export interface BackoffSpec {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export interface PortProbe {
  kind: 'port';
  port: number;
  host: string;
  intervalMs: number;
  initialDelayMs: number;
  timeoutMs: number;
  onTimeout: ProbeOnTimeout;
}

export interface LogMatchProbe {
  kind: 'log_match';
  pattern: RegExp;
  timeoutMs: number;
  onTimeout: ProbeOnTimeout;
}

export interface HttpProbe {
  kind: 'http';
  url: string;
  expectStatus?: number;
  intervalMs: number;
  initialDelayMs: number;
  timeoutMs: number;
  onTimeout: ProbeOnTimeout;
}

export type ReadyProbe = PortProbe | LogMatchProbe | HttpProbe;

export interface ExposeSpec {
  /** The port this service listens on inside the box. */
  port: number;
  /** Container port forwarded to it. Only 80 is reserved/published today. */
  as: number;
}

/**
 * Declarative "run once" for a task. The supervisor re-runs every task from
 * `pending` on each box start; `run_once` lets it skip a task that has already
 * succeeded.
 *
 * - `{ kind: 'marker' }` (from `run_once: true`) — the supervisor stores a
 *   marker keyed by a hash of the resolved command; a warm boot skips while the
 *   hash matches, and editing the command re-runs.
 * - `{ kind: 'check', command }` (from `run_once: { check: ... }`) — run the
 *   probe before launching; exit 0 means already satisfied (skip). No marker:
 *   the probe is the source of truth (right for data that lives outside the
 *   checkpointed filesystem, e.g. a containerized DB).
 */
export type RunOnceSpec = { kind: 'marker' } | { kind: 'check'; command: string };

export interface TaskSpec {
  name: string;
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  needs: string[];
  runOnce?: RunOnceSpec;
}

export interface ServiceSpec {
  name: string;
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  autostart: boolean;
  restart: RestartPolicy;
  backoff: BackoffSpec;
  needs: string[];
  readyWhen?: ReadyProbe;
  /** When set, container port `expose.as` forwards to `127.0.0.1:expose.port`. */
  expose?: ExposeSpec;
  /**
   * Declarative docker sidecar. When set, `command` is synthesized into a
   * `docker start`-or-`run` shell (the in-box dockerd container is reused by
   * name across restarts). Mutually exclusive with a user `command`. The other
   * `*image*` fields below are kept for introspection; `env` is baked into the
   * container's `-e` flags and not set as the process env.
   */
  image?: string;
  /** Port publishes ("<host>:<container>" or "<port>"); image services only. */
  ports?: string[];
  /** Extra args appended after the image (shell-tokenized); image services only. */
  args?: string;
  /** Container name (default = service name); image services only. */
  containerName?: string;
}

export interface CtlConfig {
  services: ServiceSpec[];
  tasks: TaskSpec[];
  /** Named reusable replacement rule-sets (top-level `replacements:` block). */
  replacements: Record<string, ReplaceRule[]>;
}

export const DEFAULT_BACKOFF: BackoffSpec = {
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
};

export const DEFAULT_PROBE_INTERVAL_MS = 500;
export const DEFAULT_PROBE_INITIAL_DELAY_MS = 0;
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_HOST = '127.0.0.1';
export const DEFAULT_PROBE_ON_TIMEOUT: ProbeOnTimeout = 'kill';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseEnv(raw: unknown, where: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}.env must be a mapping of string → string`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new ConfigError(`${where}.env.${k} must be a scalar`);
    }
    out[k] = String(v);
  }
  return out;
}

function parseCommand(raw: unknown, where: string): string | string[] {
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      throw new ConfigError(`${where}.command must not be empty`);
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new ConfigError(`${where}.command array must not be empty`);
    }
    const argv: string[] = [];
    for (const [i, item] of raw.entries()) {
      if (typeof item !== 'string') {
        throw new ConfigError(`${where}.command[${String(i)}] must be a string`);
      }
      argv.push(item);
    }
    return argv;
  }
  throw new ConfigError(`${where}.command must be a string or array of strings`);
}

function parseRestart(raw: unknown, where: string): RestartPolicy {
  if (raw === undefined) return 'on-failure';
  if (raw === 'always' || raw === 'on-failure' || raw === 'never') return raw;
  throw new ConfigError(`${where}.restart must be one of: always, on-failure, never`);
}

const BACKOFF_KEYS = new Set(['initial_ms', 'max_ms', 'factor']);

function parseBackoff(raw: unknown, where: string): BackoffSpec {
  if (raw === undefined) return { ...DEFAULT_BACKOFF };
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}.backoff must be a mapping`);
  }
  rejectUnknownKeys(raw, BACKOFF_KEYS, `${where}.backoff`);
  const initialMs = parseNonNegativeInt(
    raw.initial_ms,
    `${where}.backoff.initial_ms`,
    DEFAULT_BACKOFF.initialMs,
  );
  const maxMs = parseNonNegativeInt(raw.max_ms, `${where}.backoff.max_ms`, DEFAULT_BACKOFF.maxMs);
  const factor = parseFactor(raw.factor, `${where}.backoff.factor`, DEFAULT_BACKOFF.factor);
  if (maxMs < initialMs) {
    throw new ConfigError(`${where}.backoff.max_ms must be >= initial_ms`);
  }
  return { initialMs, maxMs, factor };
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${where} has unknown key "${key}"`);
    }
  }
}

function parseNonNegativeInt(raw: unknown, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new ConfigError(`${where} must be a non-negative number`);
  }
  return Math.floor(raw);
}

function parsePositiveInt(raw: unknown, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    throw new ConfigError(`${where} must be a positive integer`);
  }
  return Math.floor(raw);
}

function parseFactor(raw: unknown, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    throw new ConfigError(`${where} must be a number >= 1`);
  }
  return raw;
}

function parseOnTimeout(raw: unknown, where: string): ProbeOnTimeout {
  if (raw === undefined) return DEFAULT_PROBE_ON_TIMEOUT;
  if (raw === 'kill' || raw === 'mark_unhealthy') return raw;
  throw new ConfigError(`${where} must be one of: kill, mark_unhealthy`);
}

function parseNeeds(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${where} must be an array of unit names`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'string') {
      throw new ConfigError(`${where}[${String(i)}] must be a string`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(item)) {
      throw new ConfigError(`${where}[${String(i)}] "${item}" must match [A-Za-z0-9_-]+`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

const PROBE_KEYS = new Set([
  'port',
  'host',
  'log_match',
  'http',
  'expect_status',
  'interval_ms',
  'initial_delay_ms',
  'timeout_ms',
  'on_timeout',
]);

function parseReadyWhen(raw: unknown, where: string): ReadyProbe | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}.ready_when must be a mapping`);
  }
  rejectUnknownKeys(raw, PROBE_KEYS, `${where}.ready_when`);

  const kinds: Array<'port' | 'log_match' | 'http'> = [];
  if (raw.port !== undefined) kinds.push('port');
  if (raw.log_match !== undefined) kinds.push('log_match');
  if (raw.http !== undefined) kinds.push('http');
  if (kinds.length === 0) {
    throw new ConfigError(
      `${where}.ready_when must declare exactly one of: port, log_match, http`,
    );
  }
  if (kinds.length > 1) {
    throw new ConfigError(
      `${where}.ready_when may declare only one of: port, log_match, http (got ${kinds.join(', ')})`,
    );
  }

  const timeoutMs = parsePositiveInt(
    raw.timeout_ms,
    `${where}.ready_when.timeout_ms`,
    DEFAULT_PROBE_TIMEOUT_MS,
  );
  const onTimeout = parseOnTimeout(raw.on_timeout, `${where}.ready_when.on_timeout`);

  const kind = kinds[0]!;
  if (kind === 'log_match') {
    if (raw.host !== undefined || raw.expect_status !== undefined || raw.interval_ms !== undefined || raw.initial_delay_ms !== undefined) {
      throw new ConfigError(
        `${where}.ready_when.log_match cannot be combined with host/expect_status/interval_ms/initial_delay_ms`,
      );
    }
    const pat = assertString(raw.log_match, `${where}.ready_when.log_match`);
    let pattern: RegExp;
    try {
      pattern = new RegExp(pat);
    } catch (err) {
      throw new ConfigError(
        `${where}.ready_when.log_match is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { kind: 'log_match', pattern, timeoutMs, onTimeout };
  }

  const intervalMs = parsePositiveInt(
    raw.interval_ms,
    `${where}.ready_when.interval_ms`,
    DEFAULT_PROBE_INTERVAL_MS,
  );
  const initialDelayMs = parseNonNegativeInt(
    raw.initial_delay_ms,
    `${where}.ready_when.initial_delay_ms`,
    DEFAULT_PROBE_INITIAL_DELAY_MS,
  );

  if (kind === 'port') {
    if (raw.expect_status !== undefined) {
      throw new ConfigError(`${where}.ready_when.expect_status only applies to http probes`);
    }
    const port = parsePositiveInt(raw.port, `${where}.ready_when.port`, 0);
    if (port < 1 || port > 65535) {
      throw new ConfigError(`${where}.ready_when.port must be between 1 and 65535`);
    }
    const host =
      raw.host === undefined
        ? DEFAULT_PROBE_HOST
        : assertString(raw.host, `${where}.ready_when.host`);
    return { kind: 'port', port, host, intervalMs, initialDelayMs, timeoutMs, onTimeout };
  }

  if (raw.host !== undefined) {
    throw new ConfigError(`${where}.ready_when.host only applies to port probes`);
  }
  const url = assertString(raw.http, `${where}.ready_when.http`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${where}.ready_when.http must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${where}.ready_when.http must use http(s):// (got ${parsed.protocol})`);
  }
  let expectStatus: number | undefined;
  if (raw.expect_status !== undefined) {
    expectStatus = parsePositiveInt(raw.expect_status, `${where}.ready_when.expect_status`, 0);
    if (expectStatus < 100 || expectStatus > 599) {
      throw new ConfigError(`${where}.ready_when.expect_status must be between 100 and 599`);
    }
  }
  return { kind: 'http', url, expectStatus, intervalMs, initialDelayMs, timeoutMs, onTimeout };
}

/**
 * The only container port AgentBox reserves + publishes for a web service today
 * (see `WEB_CONTAINER_PORT` host-side in @agentbox/sandbox-docker). A service's
 * `expose.as` must equal this — any other value would parse fine but be
 * unreachable from the host, so we reject it loudly.
 */
export const RESERVED_WEB_PORT = 80;

const SERVICE_KEYS = new Set([
  'command',
  'cwd',
  'env',
  'autostart',
  'restart',
  'backoff',
  'needs',
  'ready_when',
  'expose',
  'ide',
  'image',
  'ports',
  'args',
  'container_name',
]);

// Minimal POSIX single-quote escaping for values baked into a generated
// `bash -c` docker command. (sandbox-cloud has an equivalent quoteShellArg, but
// ctl can't depend on it — wrong direction.)
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parsePorts(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${where}.ports must be a list of "<host>:<container>" strings`);
  }
  const out: string[] = [];
  for (const [i, v] of raw.entries()) {
    const s = typeof v === 'number' ? String(v) : v;
    if (typeof s !== 'string' || !/^\d+(:\d+)?$/.test(s.trim())) {
      throw new ConfigError(
        `${where}.ports[${String(i)}] must be "<host>" or "<host>:<container>" (got ${JSON.stringify(v)})`,
      );
    }
    out.push(s.trim());
  }
  return out.length > 0 ? out : undefined;
}

// `args` is a string (appended raw, bash word-splits) or a list of strings
// (joined with spaces, then bash word-splits) — so both `args: "-c x=1"` and
// `args: ["-c", "x=1"]` produce the same docker invocation.
function parseArgs(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw : undefined;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const [i, v] of raw.entries()) {
      if (typeof v !== 'string') throw new ConfigError(`${where}.args[${String(i)}] must be a string`);
      parts.push(v);
    }
    const joined = parts.join(' ').trim();
    return joined.length > 0 ? joined : undefined;
  }
  throw new ConfigError(`${where}.args must be a string or a list of strings`);
}

// Build the start-or-run shell for an `image:` service. Reuses the existing
// container by name across restarts (data lives in the per-box /var/lib/docker);
// a config change needs a manual `docker rm <name>`.
function synthesizeImageCommand(opts: {
  image: string;
  name: string;
  ports?: string[];
  env?: Record<string, string>;
  args?: string;
}): string {
  const name = shQuote(opts.name);
  const run = ['docker', 'run', '--name', name];
  for (const p of opts.ports ?? []) run.push('-p', shQuote(p));
  for (const [k, v] of Object.entries(opts.env ?? {})) run.push('-e', `${k}=${shQuote(v)}`);
  run.push(shQuote(opts.image));
  let runLine = run.join(' ');
  if (opts.args) runLine += ` ${opts.args}`; // raw — bash word-splits
  return [
    'set -e',
    `if docker container inspect ${name} >/dev/null 2>&1; then`,
    `  docker start ${name} >/dev/null`,
    `  exec docker logs -f ${name}`,
    'else',
    `  exec ${runLine}`,
    'fi',
  ].join('\n');
}

const EXPOSE_KEYS = new Set(['port', 'as']);

function parseExpose(raw: unknown, where: string): ExposeSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}.expose must be a mapping`);
  }
  rejectUnknownKeys(raw, EXPOSE_KEYS, `${where}.expose`);
  if (raw.port === undefined) {
    throw new ConfigError(`${where}.expose.port is required`);
  }
  const port = parsePortNumber(raw.port, `${where}.expose.port`);
  const as = raw.as === undefined ? RESERVED_WEB_PORT : parsePortNumber(raw.as, `${where}.expose.as`);
  if (as !== RESERVED_WEB_PORT) {
    throw new ConfigError(
      `${where}.expose.as must be ${String(RESERVED_WEB_PORT)} (the only container port AgentBox publishes)`,
    );
  }
  return { port, as };
}

function parsePortNumber(raw: unknown, where: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new ConfigError(`${where} must be an integer between 1 and 65535`);
  }
  return raw;
}

function parseService(name: string, raw: unknown): ServiceSpec {
  const where = `services.${name}`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  rejectUnknownKeys(raw, SERVICE_KEYS, where);

  const hasImage = raw.image !== undefined && raw.image !== null;
  const hasCommand = raw.command !== undefined && raw.command !== null;
  if (hasImage && hasCommand) {
    throw new ConfigError(`${where} sets both command and image — use exactly one`);
  }
  if (!hasImage && !hasCommand) {
    throw new ConfigError(`${where} must set either command or image`);
  }

  const cwd = raw.cwd === undefined ? undefined : assertString(raw.cwd, `${where}.cwd`);
  const autostart =
    raw.autostart === undefined ? true : assertBool(raw.autostart, `${where}.autostart`);
  const restart = parseRestart(raw.restart, where);
  const backoff = parseBackoff(raw.backoff, where);
  const needs = parseNeeds(raw.needs, `${where}.needs`);
  const readyWhen = parseReadyWhen(raw.ready_when, where);
  const expose = parseExpose(raw.expose, where);

  if (hasImage) {
    const image = assertString(raw.image, `${where}.image`).trim();
    if (image.length === 0) throw new ConfigError(`${where}.image must not be empty`);
    const ports = parsePorts(raw.ports, where);
    const args = parseArgs(raw.args, where);
    const env = parseEnv(raw.env, where); // container -e env
    const containerName =
      raw.container_name === undefined
        ? name
        : assertString(raw.container_name, `${where}.container_name`).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
      throw new ConfigError(
        `${where}.container_name "${containerName}" is not a valid docker container name`,
      );
    }
    const command = synthesizeImageCommand({ image, name: containerName, ports, env, args });
    const spec: ServiceSpec = {
      name,
      command,
      cwd,
      autostart,
      restart,
      backoff,
      needs,
      readyWhen,
      expose,
      image,
      containerName,
    };
    if (ports !== undefined) spec.ports = ports;
    if (args !== undefined) spec.args = args;
    return spec;
  }

  // command service — the image-only keys are rejected.
  for (const k of ['ports', 'args', 'container_name']) {
    if (raw[k] !== undefined) {
      throw new ConfigError(`${where}.${k} is only valid alongside image:`);
    }
  }
  const command = parseCommand(raw.command, where);
  const env = parseEnv(raw.env, where);
  return { name, command, cwd, env, autostart, restart, backoff, needs, readyWhen, expose };
}

const TASK_KEYS = new Set(['command', 'cwd', 'env', 'needs', 'run_once']);

function parseRunOnce(raw: unknown, where: string): RunOnceSpec | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { kind: 'marker' };
  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'check') {
      throw new ConfigError(`${where}.run_once object form must be exactly { check: <command> }`);
    }
    const check = raw.check;
    if (typeof check !== 'string' || check.trim().length === 0) {
      throw new ConfigError(`${where}.run_once.check must be a non-empty command string`);
    }
    return { kind: 'check', command: check };
  }
  throw new ConfigError(`${where}.run_once must be true or { check: <command> }`);
}

function parseTask(name: string, raw: unknown): TaskSpec {
  const where = `tasks.${name}`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  rejectUnknownKeys(raw, TASK_KEYS, where);
  const command = parseCommand(raw.command, where);
  const cwd = raw.cwd === undefined ? undefined : assertString(raw.cwd, `${where}.cwd`);
  const env = parseEnv(raw.env, where);
  const needs = parseNeeds(raw.needs, `${where}.needs`);
  const runOnce = parseRunOnce(raw.run_once, where);
  const spec: TaskSpec = { name, command, cwd, env, needs };
  if (runOnce !== undefined) spec.runOnce = runOnce;
  return spec;
}

function assertString(raw: unknown, where: string): string {
  if (typeof raw !== 'string') throw new ConfigError(`${where} must be a string`);
  return raw;
}

function assertBool(raw: unknown, where: string): boolean {
  if (typeof raw !== 'boolean') throw new ConfigError(`${where} must be a boolean`);
  return raw;
}

// `defaults` is the host-side config layer (read by @agentbox/config) — the
// supervisor doesn't touch it, but we accept it here so `ctl validate` doesn't
// flag it as unknown. Strict typo-detection still applies (top-level keys
// outside this set are rejected).
// `carry` is the host-side declarative file-carry block (read by the apps/cli
// layer via @agentbox/ctl/carry, applied at create time). The supervisor never
// reads it — listing it here only suppresses the unknown-key error so a project
// yaml that declares `carry:` still parses cleanly inside the box.
// `replacements` is the top-level reusable replacement-rule block, consumed by
// the in-box `agentbox-ctl render` CLI and host-side `carry:` rule refs. We
// parse + validate it here (regex compile-check) so a typo fails loud in-box.
const TOP_LEVEL_KEYS = new Set(['services', 'tasks', 'ide', 'defaults', 'carry', 'replacements']);

function validateUnitGraph(tasks: TaskSpec[], services: ServiceSpec[]): void {
  const names = new Set<string>();
  for (const t of tasks) {
    if (names.has(t.name)) {
      throw new ConfigError(`unit name "${t.name}" declared more than once (task vs service collision)`);
    }
    names.add(t.name);
  }
  for (const s of services) {
    if (names.has(s.name)) {
      throw new ConfigError(`unit name "${s.name}" declared more than once (task vs service collision)`);
    }
    names.add(s.name);
  }

  const deps = new Map<string, string[]>();
  for (const t of tasks) deps.set(t.name, t.needs);
  for (const s of services) deps.set(s.name, s.needs);

  for (const [unit, list] of deps) {
    for (const dep of list) {
      if (!names.has(dep)) {
        throw new ConfigError(`unit "${unit}" needs unknown unit "${dep}"`);
      }
      if (dep === unit) {
        throw new ConfigError(`unit "${unit}" cannot depend on itself`);
      }
    }
  }

  // DFS with three-color marking; record the cycle path in the error.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const name of deps.keys()) color.set(name, WHITE);
  const stack: string[] = [];

  function visit(name: string): void {
    color.set(name, GRAY);
    stack.push(name);
    for (const dep of deps.get(name)!) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const startIdx = stack.indexOf(dep);
        const cycle = stack.slice(startIdx).concat(dep).join(' → ');
        throw new ConfigError(`cyclic dependency: ${cycle}`);
      }
      if (c === WHITE) visit(dep);
    }
    stack.pop();
    color.set(name, BLACK);
  }

  for (const name of deps.keys()) {
    if (color.get(name) === WHITE) visit(name);
  }
}

export function parseConfig(text: string): CtlConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`yaml parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) return { services: [], tasks: [], replacements: {} };
  if (!isPlainObject(doc)) {
    throw new ConfigError('top-level config must be a mapping');
  }
  rejectUnknownKeys(doc, TOP_LEVEL_KEYS, '(root)');

  const services: ServiceSpec[] = [];
  const servicesRaw = doc.services;
  if (servicesRaw !== undefined && servicesRaw !== null) {
    if (!isPlainObject(servicesRaw)) {
      throw new ConfigError('services must be a mapping of name → service');
    }
    for (const [name, raw] of Object.entries(servicesRaw)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new ConfigError(`service name "${name}" must match [A-Za-z0-9_-]+`);
      }
      services.push(parseService(name, raw));
    }
  }

  const tasks: TaskSpec[] = [];
  const tasksRaw = doc.tasks;
  if (tasksRaw !== undefined && tasksRaw !== null) {
    if (!isPlainObject(tasksRaw)) {
      throw new ConfigError('tasks must be a mapping of name → task');
    }
    for (const [name, raw] of Object.entries(tasksRaw)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new ConfigError(`task name "${name}" must match [A-Za-z0-9_-]+`);
      }
      tasks.push(parseTask(name, raw));
    }
  }

  // ide: parsed only enough to confirm it's an object; contents are host-side
  // and the supervisor doesn't touch them. Schema is permissive here too.
  if (doc.ide !== undefined && doc.ide !== null && !isPlainObject(doc.ide)) {
    throw new ConfigError('ide must be a mapping');
  }

  // defaults: host-side layered-config block. We only require it to be a
  // mapping here; @agentbox/config validates the leaves strictly when the
  // host loads the file. Letting ctl deep-validate would force a circular
  // dependency on the host-only @agentbox/config package — see CLAUDE.md.
  if (doc.defaults !== undefined && doc.defaults !== null && !isPlainObject(doc.defaults)) {
    throw new ConfigError('defaults must be a mapping');
  }

  validateUnitGraph(tasks, services);

  const exposed = services.filter((s) => s.expose);
  if (exposed.length > 1) {
    throw new ConfigError(
      `at most one service may set expose: (got: ${exposed.map((s) => s.name).join(', ')})`,
    );
  }

  let replacements: Record<string, ReplaceRule[]>;
  try {
    replacements = parseReplacements(doc.replacements);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }

  return { services, tasks, replacements };
}

export async function loadConfig(path: string): Promise<CtlConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { services: [], tasks: [], replacements: {} };
    }
    throw err;
  }
  return parseConfig(text);
}

export function describeCommand(cmd: string | string[]): string {
  return Array.isArray(cmd) ? cmd.join(' ') : cmd;
}
