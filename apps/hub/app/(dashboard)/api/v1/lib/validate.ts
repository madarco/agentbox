// Hand-rolled request validation for the public API boundary. The repo has no zod
// convention (validation is typeof-guards throughout); these mirror that style and
// return a discriminated result so routes stay a flat parse-then-act.
import type { CreateBoxInput, CreateBoxOpts } from '@/lib/boxes/backend-types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; details?: unknown };

// 'none' = create the box without starting an agent (like `agentbox create`).
const AGENTS = ['claude', 'codex', 'opencode', 'none'] as const;
// Sandbox providers (mirrors @agentbox/config PROVIDER_NAMES; hardcoded to keep
// that package out of the Next bundle, like AGENTS above). The backend enforces
// that the chosen provider is actually configured on the host.
const PROVIDERS = [
  'docker',
  'daytona',
  'hetzner',
  'vercel',
  'e2b',
  'digitalocean',
  'remote-docker',
] as const;
// `screen` isn't lifecycle strictly speaking — it's the open-VNC prep step
// (point the in-box browser at the web app) — but it shares the exact
// POST /boxes/:id/:action shape and backend dispatch.
export const LIFECYCLE_ACTIONS = ['start', 'pause', 'resume', 'stop', 'destroy', 'screen'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCreateBox(body: unknown): Parsed<CreateBoxInput> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { projectId, repoUrl, agent, provider, name, prompt, fromBranch, setupWizard } = body;
  const { agentArgs, startAgent, foreground, opts } = body;
  // Exactly one of projectId / repoUrl: projectId → a registered project on the
  // hub's machine (local file queue); repoUrl → the origin the control-plane
  // worker clones (no local checkout).
  const hasProject = typeof projectId === 'string' && projectId.length > 0;
  const hasRepo = typeof repoUrl === 'string' && repoUrl.length > 0;
  if (!hasProject && !hasRepo) {
    return { ok: false, message: 'one of projectId or repoUrl is required (string)' };
  }
  // Exactly one: the backend forks on `repoUrl` (clone) vs `projectId` (local
  // workspace), so sending both is ambiguous — repoUrl would win and silently
  // skip a valid local checkout.
  if (hasProject && hasRepo) {
    return { ok: false, message: 'send exactly one of projectId or repoUrl, not both' };
  }
  if (projectId !== undefined && typeof projectId !== 'string') {
    return { ok: false, message: 'projectId must be a string' };
  }
  if (repoUrl !== undefined && typeof repoUrl !== 'string') {
    return { ok: false, message: 'repoUrl must be a string' };
  }
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) {
    return {
      ok: false,
      message: `agent must be one of ${AGENTS.join(', ')}`,
      details: { got: agent },
    };
  }
  // A host-qualified `docker:<alias>` / `remote-docker:<alias>` spec picks a
  // registered remote-docker host (alias rule mirrors the hosts registry). The
  // backend validates the alias exists; here we only gate the shape.
  const isHostSpec =
    typeof provider === 'string' &&
    /^(?:docker|remote-docker):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider);
  // A name outside the built-in list may still be a registered provider PLUGIN.
  // The plugin registry lives behind @agentbox/sandbox-core, which must stay out
  // of the Next bundle (see PROVIDERS above), so this boundary only checks the
  // SHAPE of an unknown name — the backend resolves it against the registry and
  // rejects it there with a precise message.
  if (
    provider !== undefined &&
    !isHostSpec &&
    (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(provider))
  ) {
    return {
      ok: false,
      message: `provider must be one of ${PROVIDERS.join(', ')}, a registered plugin provider, or a docker:<host> spec`,
      details: { got: provider },
    };
  }
  if (name !== undefined && typeof name !== 'string')
    return { ok: false, message: 'name must be a string' };
  if (prompt !== undefined && typeof prompt !== 'string')
    return { ok: false, message: 'prompt must be a string' };
  const fb = optionalString(fromBranch, 'fromBranch');
  if (!fb.ok) return fb;
  const sw = optionalBool(setupWizard, 'setupWizard');
  if (!sw.ok) return sw;
  const aa = optionalStringArray(agentArgs, 'agentArgs');
  if (!aa.ok) return aa;
  const sa = optionalBool(startAgent, 'startAgent');
  if (!sa.ok) return sa;
  const fg = optionalBool(foreground, 'foreground');
  if (!fg.ok) return fg;
  const po = parseCreateBoxOpts(opts);
  if (!po.ok) return po;
  return {
    ok: true,
    value: {
      projectId: hasProject ? (projectId as string) : undefined,
      repoUrl: hasRepo ? (repoUrl as string) : undefined,
      agent: agent as CreateBoxInput['agent'],
      provider: provider as CreateBoxInput['provider'],
      name,
      prompt,
      agentArgs: aa.value,
      startAgent: sa.value,
      foreground: fg.value,
      fromBranch: fb.value,
      setupWizard: sw.value,
      opts: po.value,
    },
  };
}

// The CLI's box-shaping create knobs (see CreateBoxOpts). Every field optional;
// absent → the worker's config default. Kept permissive on the value types (the
// backend + provider validate the semantics) — this only guards the wire shape.
function parseCreateBoxOpts(v: unknown): Parsed<CreateBoxOpts | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!isObject(v)) return { ok: false, message: 'opts must be a JSON object' };
  const out: CreateBoxOpts = {};
  const strFields = [
    'image',
    'snapshot',
    'memory',
    'cpus',
    'pidsLimit',
    'disk',
    'size',
    'location',
    'inbound',
    'useBranch',
    'imageRegistry',
    'remoteHost',
    'sessionName',
  ] as const;
  for (const f of strFields) {
    const r = optionalString(v[f], `opts.${f}`);
    if (!r.ok) return r;
    if (r.value !== undefined) (out as Record<string, unknown>)[f] = r.value;
  }
  const boolFields = [
    'hostSnapshot',
    'withPlaywright',
    'withEnv',
    'vnc',
    'resync',
    'sharedDockerCache',
    'portless',
    'build',
    'credentialSync',
    'dangerouslySkipPermissions',
  ] as const;
  for (const f of boolFields) {
    const r = optionalBool(v[f], `opts.${f}`);
    if (!r.ok) return r;
    if (r.value !== undefined) (out as Record<string, unknown>)[f] = r.value;
  }
  const bd = optionalNumber(v.bundleDepth, 'opts.bundleDepth');
  if (!bd.ok) return bd;
  if (bd.value !== undefined) out.bundleDepth = bd.value;
  const ef = optionalStringArray(v.envFiles, 'opts.envFiles');
  if (!ef.ok) return ef;
  if (ef.value !== undefined) out.envFiles = ef.value;
  if (v.gitPushMode !== undefined) {
    const modes = ['auto', 'relay', 'lease', 'direct'];
    if (typeof v.gitPushMode !== 'string' || !modes.includes(v.gitPushMode)) {
      return { ok: false, message: `opts.gitPushMode must be one of ${modes.join(', ')}` };
    }
    out.gitPushMode = v.gitPushMode as CreateBoxOpts['gitPushMode'];
  }
  // carry: ResolvedCarryEntry[] (opaque host-path metadata the worker reads).
  if (v.carry !== undefined) {
    if (!Array.isArray(v.carry)) return { ok: false, message: 'opts.carry must be an array' };
    out.carry = v.carry;
  }
  return { ok: true, value: out };
}

// Rename a box: set (or clear, with an empty string) its cosmetic display label.
// The backend trims + clears on blank; here we only enforce the shape + a length
// cap (matching the CLI's --set-name cap).
export function parseRenameBox(body: unknown): Parsed<{ displayName: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { displayName } = body;
  if (typeof displayName !== 'string') {
    return {
      ok: false,
      message: 'displayName is required (string; empty string clears the label)',
    };
  }
  if (displayName.trim().length > 60) {
    return { ok: false, message: 'displayName too long (max 60 chars)' };
  }
  return { ok: true, value: { displayName } };
}

export function parseAnswer(body: unknown): Parsed<{ answer: 'y' | 'n'; cancelled?: boolean }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { answer, cancelled } = body;
  if (answer !== 'y' && answer !== 'n') return { ok: false, message: "answer must be 'y' or 'n'" };
  // `cancelled` marks a *dismissal* distinctly from a plain deny in the audit
  // trail (the `agent approve --cancel` capability). Optional; still resolves the
  // parked action as not-approved, so a missing/false value is a normal deny/allow.
  if (cancelled !== undefined && typeof cancelled !== 'boolean') {
    return { ok: false, message: 'cancelled must be a boolean when present' };
  }
  return { ok: true, value: { answer, ...(cancelled === true ? { cancelled: true } : {}) } };
}

export function parseLoginCode(body: unknown): Parsed<{ code: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { code } = body;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { ok: false, message: 'code is required (non-empty string)' };
  }
  return { ok: true, value: { code: code.trim() } };
}

export function parseProject(body: unknown): Parsed<{ path: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { path } = body;
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, message: 'path is required (absolute directory path)' };
  }
  return { ok: true, value: { path } };
}

export function isLifecycleAction(v: string): v is LifecycleAction {
  return (LIFECYCLE_ACTIONS as readonly string[]).includes(v);
}

// ── provider install / bake ──
// A community provider has credentials to set and (often) a base to bake, so
// rejecting unknown names here would leave a registered plugin creatable but
// unconfigurable. Same treatment as `parseCreateBox`: check only the SHAPE of an
// unknown name — the plugin registry lives behind @agentbox/sandbox-core, which
// stays out of the Next bundle — and let the backend resolve it against the
// registry and reject it there with a precise message.
export function isProviderId(v: string): boolean {
  return (PROVIDERS as readonly string[]).includes(v) || /^[a-z][a-z0-9-]{0,39}$/.test(v);
}

// Credential fields are a provider-specific record of string values (e.g.
// { apiKey }, { token }, { token, teamId?, projectId? }). We only enforce the
// generic shape here; each provider's setter validates the specific fields.
export function parseProviderCredentials(body: unknown): Parsed<Record<string, string>> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== 'string') return { ok: false, message: `field ${k} must be a string` };
    out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, message: 'at least one credential field is required' };
  }
  return { ok: true, value: out };
}

export function parseProviderPrepare(body: unknown): Parsed<{
  force?: boolean;
  claudeInstall?: 'native' | 'npm';
  build?: boolean;
  size?: string;
  location?: string;
  name?: string;
}> {
  // An empty/absent body is valid (bake with defaults).
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { force, claudeInstall, build, size, location, name } = body;
  const fb = optionalBool(force, 'force');
  if (!fb.ok) return fb;
  if (claudeInstall !== undefined && claudeInstall !== 'native' && claudeInstall !== 'npm') {
    return { ok: false, message: "claudeInstall must be 'native' or 'npm'" };
  }
  // Bake inputs (not routing): `--build` forces a local docker build; size /
  // location / name are the fixed-at-bake-time knobs threaded from the CLI. Each
  // falls back to the hub's effective config in the worker when absent here.
  const bb = optionalBool(build, 'build');
  if (!bb.ok) return bb;
  const sz = optionalString(size, 'size');
  if (!sz.ok) return sz;
  const loc = optionalString(location, 'location');
  if (!loc.ok) return loc;
  const nm = optionalString(name, 'name');
  if (!nm.ok) return nm;
  return {
    ok: true,
    value: {
      force: fb.value,
      claudeInstall: claudeInstall as 'native' | 'npm' | undefined,
      build: bb.value,
      size: sz.value,
      location: loc.value,
      name: nm.value,
    },
  };
}

// ── remote-docker host aliases ──
// Mirrors isValidAlias in @agentbox/sandbox-remote-docker; replicated (not imported)
// to keep that package out of the Next bundle, like PROVIDERS/AGENTS above.
const HOST_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidHostAlias(v: string): boolean {
  return HOST_ALIAS_RE.test(v);
}

/** A private key large enough to be one, small enough not to be an upload. */
const MAX_IDENTITY_BYTES = 16 * 1024;

export interface HostUpsert {
  alias: string;
  ssh: string;
  default?: boolean;
  /**
   * The portable expansion of `ssh`, for a host shared BY another machine: an
   * `~/.ssh/config` alias means nothing here, so a sharing client sends what
   * `ssh -G` resolved.
   */
  connection?: { host: string; user?: string; port?: number };
  /**
   * PEM of the private key this hub should dial with. Written to the hub's own
   * key dir; never stored in the registry and never echoed back.
   */
  identity?: string;
}

export function parseHostUpsert(body: unknown): Parsed<HostUpsert> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { alias, ssh, default: dflt, connection, identity } = body;
  if (typeof alias !== 'string' || !isValidHostAlias(alias)) {
    return {
      ok: false,
      message: 'alias must be a plain name (letters, digits, ., _, -; no @, :, /)',
    };
  }
  if (typeof ssh !== 'string' || ssh.trim().length === 0) {
    return { ok: false, message: 'ssh is required (an ~/.ssh/config alias or [user@]host[:port])' };
  }
  const db = optionalBool(dflt, 'default');
  if (!db.ok) return db;

  const value: HostUpsert = { alias, ssh: ssh.trim(), default: db.value };

  if (connection !== undefined) {
    if (!isObject(connection)) return { ok: false, message: 'connection must be an object' };
    const { host, user, port } = connection;
    if (typeof host !== 'string' || host.trim().length === 0) {
      return { ok: false, message: 'connection.host is required when connection is given' };
    }
    // A host that is itself an alias would defeat the point of sending one.
    if (/[@/\s]/.test(host.trim())) {
      return { ok: false, message: 'connection.host must be a hostname or IP' };
    }
    const conn: NonNullable<HostUpsert['connection']> = { host: host.trim() };
    if (user !== undefined) {
      if (typeof user !== 'string' || user.trim().length === 0) {
        return { ok: false, message: 'connection.user must be a non-empty string' };
      }
      conn.user = user.trim();
    }
    if (port !== undefined) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, message: 'connection.port must be a port number' };
      }
      conn.port = port;
    }
    value.connection = conn;
  }

  if (identity !== undefined) {
    if (typeof identity !== 'string' || !identity.includes('PRIVATE KEY')) {
      return { ok: false, message: 'identity must be a PEM-encoded private key' };
    }
    if (Buffer.byteLength(identity, 'utf8') > MAX_IDENTITY_BYTES) {
      return { ok: false, message: 'identity is too large to be a private key' };
    }
    if (!value.connection) {
      // Without the expansion the key has nothing to authenticate against: the
      // `ssh` string may be an alias this machine cannot resolve.
      return { ok: false, message: 'identity requires connection (send the ssh -G expansion)' };
    }
    value.identity = identity;
  }

  return { ok: true, value };
}

// ── git operations ──
export const GIT_OPS = ['checkout', 'branch', 'pull', 'push', 'push-host'] as const;
export type GitOp = (typeof GIT_OPS)[number];

export function isGitOp(v: string): v is GitOp {
  return (GIT_OPS as readonly string[]).includes(v);
}

// Host apps a box can be launched in (mirrors OPEN_IN_APPS in the CLI's
// _open-in.ts; hardcoded to keep @agentbox/* out of the Next bundle).
export const OPEN_IN_APPS = [
  'claude',
  'codex',
  'herdr',
  'cmux',
  'vscode',
  'iterm2',
  'finder',
] as const;
export type OpenInApp = (typeof OPEN_IN_APPS)[number];

export function isOpenInApp(v: string): v is OpenInApp {
  return (OPEN_IN_APPS as readonly string[]).includes(v);
}

export function parseOpenIn(body: unknown): Parsed<{ app: OpenInApp }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { app } = body;
  if (typeof app !== 'string' || !isOpenInApp(app)) {
    return {
      ok: false,
      message: `app must be one of ${OPEN_IN_APPS.join(', ')}`,
      details: { got: app },
    };
  }
  return { ok: true, value: { app } };
}

function optionalString(v: unknown, field: string): Parsed<string | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, message: `${field} must be a string` };
  return { ok: true, value: v };
}

function optionalBool(v: unknown, field: string): Parsed<boolean | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'boolean') return { ok: false, message: `${field} must be a boolean` };
  return { ok: true, value: v };
}
function optionalNumber(v: unknown, field: string): Parsed<number | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v))
    return { ok: false, message: `${field} must be a number` };
  return { ok: true, value: v };
}

// Extra passthrough flags for a git op (e.g. --tags, --force-with-lease). Every
// element must be a string; an absent/empty list is normalized to undefined so
// it stays out of the RPC params hash the relay's host-initiated token binds to.
function optionalStringArray(v: unknown, field: string): Parsed<string[] | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(v)) return { ok: false, message: `${field} must be an array of strings` };
  for (const el of v) {
    if (typeof el !== 'string')
      return { ok: false, message: `${field} must be an array of strings` };
  }
  return { ok: true, value: v.length > 0 ? (v as string[]) : undefined };
}

export function parseGitCheckout(body: unknown): Parsed<{ branch: string; args?: string[] }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { branch } = body;
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    return { ok: false, message: 'branch is required (non-empty string)' };
  }
  const args = optionalStringArray(body.args, 'args');
  if (!args.ok) return args;
  return { ok: true, value: { branch, args: args.value } };
}

export function parseGitBranch(body: unknown): Parsed<{ name: string; from?: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { name, from } = body;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'name is required (non-empty string)' };
  }
  const f = optionalString(from, 'from');
  if (!f.ok) return f;
  return { ok: true, value: { name, from: f.value } };
}

export function parseGitPush(
  body: unknown,
): Parsed<{ remote?: string; force?: boolean; args?: string[] }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const remote = optionalString(body.remote, 'remote');
  if (!remote.ok) return remote;
  const force = optionalBool(body.force, 'force');
  if (!force.ok) return force;
  const args = optionalStringArray(body.args, 'args');
  if (!args.ok) return args;
  return { ok: true, value: { remote: remote.value, force: force.value, args: args.value } };
}

export function parseGitPull(
  body: unknown,
): Parsed<{ remote?: string; ffOnly?: boolean; args?: string[] }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const remote = optionalString(body.remote, 'remote');
  if (!remote.ok) return remote;
  const ffOnly = optionalBool(body.ffOnly, 'ffOnly');
  if (!ffOnly.ok) return ffOnly;
  const args = optionalStringArray(body.args, 'args');
  if (!args.ok) return args;
  return { ok: true, value: { remote: remote.value, ffOnly: ffOnly.value, args: args.value } };
}

export function parseGitPushHost(
  body: unknown,
): Parsed<{ as?: string; force?: boolean; args?: string[] }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const as = optionalString(body.as, 'as');
  if (!as.ok) return as;
  const force = optionalBool(body.force, 'force');
  if (!force.ok) return force;
  const args = optionalStringArray(body.args, 'args');
  if (!args.ok) return args;
  return { ok: true, value: { as: as.value, force: force.value, args: args.value } };
}

export function parseServiceRestart(body: unknown): Parsed<{ name?: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const name = optionalString(body.name, 'name');
  if (!name.ok) return name;
  return { ok: true, value: { name: name.value } };
}

// ── checkpoints ──
// Capture a box state as a project checkpoint. An empty/absent body is valid
// (auto-named, layered, not-default). `merged` is docker-only (cloud snapshots
// are always flattened); the backend ignores it for cloud.
export function parseCheckpointCreate(body: unknown): Parsed<{
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  replace?: boolean;
}> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const name = optionalString(body.name, 'name');
  if (!name.ok) return name;
  const merged = optionalBool(body.merged, 'merged');
  if (!merged.ok) return merged;
  const setDefault = optionalBool(body.setDefault, 'setDefault');
  if (!setDefault.ok) return setDefault;
  const replace = optionalBool(body.replace, 'replace');
  if (!replace.ok) return replace;
  return {
    ok: true,
    value: {
      name: name.value,
      merged: merged.value,
      setDefault: setDefault.value,
      replace: replace.value,
    },
  };
}

// ── prune ──
// Fleet cleanup. Without `provider` (or provider === 'docker'): remove orphan
// docker records/resources (+ project configs with `all`). With a cloud provider
// name: enumerate untracked sandboxes, deleting them when !dryRun.
export function parsePrune(body: unknown): Parsed<{
  all?: boolean;
  dryRun?: boolean;
  provider?: string;
}> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const all = optionalBool(body.all, 'all');
  if (!all.ok) return all;
  const dryRun = optionalBool(body.dryRun, 'dryRun');
  if (!dryRun.ok) return dryRun;
  const provider = optionalString(body.provider, 'provider');
  if (!provider.ok) return provider;
  return { ok: true, value: { all: all.value, dryRun: dryRun.value, provider: provider.value } };
}

// Read + JSON-parse a request body, tolerating an empty body as {}.
export async function readJson(req: Request): Promise<Parsed<unknown>> {
  const text = await req.text();
  if (text.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: 'body is not valid JSON' };
  }
}
