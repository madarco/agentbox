// Hand-rolled request validation for the public API boundary. The repo has no zod
// convention (validation is typeof-guards throughout); these mirror that style and
// return a discriminated result so routes stay a flat parse-then-act.
import type { CreateBoxInput } from '@/lib/boxes/backend-types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; details?: unknown };

const AGENTS = ['claude', 'codex', 'opencode'] as const;
export const LIFECYCLE_ACTIONS = ['pause', 'resume', 'stop', 'destroy'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCreateBox(body: unknown): Parsed<CreateBoxInput> {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { projectId, agent, name, prompt } = body;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, message: 'projectId is required (string)' };
  }
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) {
    return { ok: false, message: `agent must be one of ${AGENTS.join(', ')}`, details: { got: agent } };
  }
  if (name !== undefined && typeof name !== 'string') return { ok: false, message: 'name must be a string' };
  if (prompt !== undefined && typeof prompt !== 'string') return { ok: false, message: 'prompt must be a string' };
  return { ok: true, value: { projectId, agent: agent as CreateBoxInput['agent'], name, prompt } };
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
