// GET /api/v1/skill-bindings[?scope&scopeId] — the hub's skill bindings: the
//     whole document, or one scope's `{ <skill>: 'include' | 'exclude' }` map.
// PUT /api/v1/skill-bindings?scope&scopeId — merge `{ bindings: { <skill>:
//     'include' | 'exclude' | null } }` into one scope (`null` clears, so the
//     skill inherits from the next scope down). Scopes: global (no scopeId),
//     workspace (16-hex id), project (repo key, e.g. github.com/owner/repo),
//     box (box id). Most specific wins: box > project > workspace > global; a
//     skill bound nowhere is in every box. A running box applies a change at its
//     next skills sync (boot, `agentbox-ctl skills sync`).
import {
  getSkillBindings,
  parseBindingChanges,
  parseBindingTarget,
  putSkillBindings,
} from '@/lib/backend/skill-bindings';
import { bindingsAt } from '@agentbox/core';
import { fail, ok } from '../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const q = new URL(req.url).searchParams;
  try {
    const doc = await getSkillBindings(store);
    if (!q.get('scope')) return ok(doc);
    const target = parseBindingTarget(q.get('scope'), q.get('scopeId'));
    return ok({ ...target, bindings: bindingsAt(doc, target.scope, target.scopeId) });
  } catch (err) {
    return failFromSkills(err, 'skill bindings read failed');
  }
}

export async function PUT(req: Request): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const q = new URL(req.url).searchParams;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'body must be JSON');
  }
  try {
    const target = parseBindingTarget(q.get('scope'), q.get('scopeId'));
    const changes = parseBindingChanges(body);
    return ok({ ...target, bindings: await putSkillBindings(store, target, changes) });
  } catch (err) {
    return failFromSkills(err, 'skill bindings write failed');
  }
}
