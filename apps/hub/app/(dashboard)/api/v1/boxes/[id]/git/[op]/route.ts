// POST /api/v1/boxes/:id/git/:op — git ops against the box's branch:
//   checkout | branch | pull | push | push-host
// Mutations need the in-process host backend; the Postgres/plane path 503s.
import type { BoxOpResult } from '@/lib/boxes/backend-types';
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import {
  GIT_OPS,
  isGitOp,
  parseGitBranch,
  parseGitCheckout,
  parseGitPull,
  parseGitPush,
  parseGitPushHost,
  readJson,
} from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await ctx.params;
  if (!isGitOp(op)) {
    return fail('invalid_request', `unknown git op: ${op}`, { allowed: [...GIT_OPS] });
  }
  // In-flight create jobs surface as synthetic `job:` boxes with no real
  // container yet — reject with a clear 409 instead of a backend 404.
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; git ops are not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const body = parsedBody.value;

  let res: BoxOpResult;
  switch (op) {
    case 'checkout': {
      const p = parseGitCheckout(body);
      if (!p.ok) return fail('invalid_request', p.message, p.details);
      res = await backend.gitCheckout(id, p.value.branch);
      break;
    }
    case 'branch': {
      const p = parseGitBranch(body);
      if (!p.ok) return fail('invalid_request', p.message, p.details);
      res = await backend.gitNewBranch(id, p.value);
      break;
    }
    case 'pull': {
      const p = parseGitPull(body);
      if (!p.ok) return fail('invalid_request', p.message, p.details);
      res = await backend.gitPull(id, p.value);
      break;
    }
    case 'push': {
      const p = parseGitPush(body);
      if (!p.ok) return fail('invalid_request', p.message, p.details);
      res = await backend.gitPush(id, p.value);
      break;
    }
    case 'push-host': {
      const p = parseGitPushHost(body);
      if (!p.ok) return fail('invalid_request', p.message, p.details);
      res = await backend.gitPushHost(id, p.value);
      break;
    }
  }

  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
}
