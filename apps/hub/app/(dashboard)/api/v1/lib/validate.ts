// Hand-rolled request validation for the public API boundary. The repo has no zod
// convention (validation is typeof-guards throughout); these mirror that style and
// return a discriminated result so routes stay a flat parse-then-act.
import type { CreateBoxInput } from '@/lib/boxes/backend-types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; details?: unknown };

// 'none' = create the box without starting an agent (like `agentbox create`).
const AGENTS = ['claude', 'codex', 'opencode', 'none'] as const;
// Sandbox providers (mirrors @agentbox/config PROVIDER_NAMES; hardcoded to keep
// that package out of the Next bundle, like AGENTS above). The backend enforces
// that the chosen provider is actually configured on the host.
const PROVIDERS = ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'] as const;
export const LIFECYCLE_ACTIONS = ['pause', 'resume', 'stop', 'destroy'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCreateBox(body: unknown): Parsed<CreateBoxInput> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { projectId, agent, provider, name, prompt } = body;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, message: 'projectId is required (string)' };
  }
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) {
    return { ok: false, message: `agent must be one of ${AGENTS.join(', ')}`, details: { got: agent } };
  }
  if (provider !== undefined && (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider))) {
    return { ok: false, message: `provider must be one of ${PROVIDERS.join(', ')}`, details: { got: provider } };
  }
  if (name !== undefined && typeof name !== 'string') return { ok: false, message: 'name must be a string' };
  if (prompt !== undefined && typeof prompt !== 'string') return { ok: false, message: 'prompt must be a string' };
  return {
    ok: true,
    value: {
      projectId,
      agent: agent as CreateBoxInput['agent'],
      provider: provider as CreateBoxInput['provider'],
      name,
      prompt,
    },
  };
}

export function parseAnswer(body: unknown): Parsed<'y' | 'n'> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { answer } = body;
  if (answer !== 'y' && answer !== 'n') return { ok: false, message: "answer must be 'y' or 'n'" };
  return { ok: true, value: answer };
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

// ── git operations ──
export const GIT_OPS = ['checkout', 'branch', 'pull', 'push', 'push-host'] as const;
export type GitOp = (typeof GIT_OPS)[number];

export function isGitOp(v: string): v is GitOp {
  return (GIT_OPS as readonly string[]).includes(v);
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

export function parseGitCheckout(body: unknown): Parsed<{ branch: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { branch } = body;
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    return { ok: false, message: 'branch is required (non-empty string)' };
  }
  return { ok: true, value: { branch } };
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

export function parseGitPush(body: unknown): Parsed<{ remote?: string; force?: boolean }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const remote = optionalString(body.remote, 'remote');
  if (!remote.ok) return remote;
  const force = optionalBool(body.force, 'force');
  if (!force.ok) return force;
  return { ok: true, value: { remote: remote.value, force: force.value } };
}

export function parseGitPull(body: unknown): Parsed<{ remote?: string; ffOnly?: boolean }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const remote = optionalString(body.remote, 'remote');
  if (!remote.ok) return remote;
  const ffOnly = optionalBool(body.ffOnly, 'ffOnly');
  if (!ffOnly.ok) return ffOnly;
  return { ok: true, value: { remote: remote.value, ffOnly: ffOnly.value } };
}

export function parseGitPushHost(body: unknown): Parsed<{ as?: string; force?: boolean }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const as = optionalString(body.as, 'as');
  if (!as.ok) return as;
  const force = optionalBool(body.force, 'force');
  if (!force.ok) return force;
  return { ok: true, value: { as: as.value, force: force.value } };
}

export function parseServiceRestart(body: unknown): Parsed<{ name?: string }> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const name = optionalString(body.name, 'name');
  if (!name.ok) return name;
  return { ok: true, value: { name: name.value } };
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
