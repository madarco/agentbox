// POST /api/v1/workspaces/:id/managers/start — run a coding agent LOCALLY in the
// workspace folder, in a detached tmux session the hub owns. The session is the
// process's home: the CLI, the tray and a plain terminal all attach to the same
// one rather than the hub proxying a PTY. A `sessionId` some manager already
// holds resumes THAT manager instead of creating a second one.
import { backendOrNull } from '../../../../lib/backend';
import { timelineMeta } from '../../../../lib/actor';
import { fail, failFromManager, ok } from '../../../../lib/envelope';
import { MANAGER_AGENT_NAMES, parseManagerStart, readJson } from '../../../../lib/validate';
import { MANAGER_CARRIER_MISSING, PTY_CARRIER_MISSING, TMUX_MISSING } from '@/lib/backend/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  // Accept whatever the registry actually knows (plugin agents included) rather
  // than the compiled-in list — GET /api/v1/agents offers them, so refusing one
  // here would advertise a manager the start path rejects. Falls back to the
  // built-ins when the seam is absent (the plane path has no registry).
  //
  // A `service` agent is excluded: it is a daemon a box hosts, with no session to
  // attach to, so running one as the manager would produce a session nobody can
  // use. `agentbox manager start` filters the same way.
  //
  // Whether the agent is INSTALLED is deliberately not asked here: this hub need
  // not be the machine that will run the session. A control box holds every
  // workspace and has no agent installed for any of them, so asking here refused
  // every start with "agent must be one of " and an empty list — before the
  // backend could answer `wrong_host` and send the client to the machine that
  // does have the folder. The backend asks it there, where it is true.
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const allowedAgents = sys
    ? sys
        .agents()
        .filter((a) => a.surface !== 'service')
        .map((a) => a.id)
    : MANAGER_AGENT_NAMES;
  const parsed = parseManagerStart(parsedBody.value, allowedAgents);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.startManager(
    id,
    parsed.value,
    await timelineMeta(req, backend, { wsId: id }),
  );
  if (!res.ok) {
    // A host without tmux cannot host a manager at all — that is an environment
    // gap on the hub's machine, not a bad request.
    if (
      res.error === TMUX_MISSING ||
      res.error === MANAGER_CARRIER_MISSING ||
      res.error === PTY_CARRIER_MISSING
    ) {
      return fail('backend_unavailable', res.error);
    }
    return failFromManager(res);
  }
  return ok(res.manager);
}
