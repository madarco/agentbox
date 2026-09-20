// POST /api/v1/managers/:id/message — type a message into the manager's session
// and submit it (`{ text, prNumber? }`); what the tray's Approve sends. A running
// hub-run manager gets it in its tmux session, a running external one in the
// tmux pane it reported, and a stopped one is resumed in the hub's tmux with the
// text as its prompt. A running external manager outside tmux cannot be reached:
// 409 `manager_unreachable`, and the client offers the text to paste instead.
import { backendOrNull } from '../../../lib/backend';
import { timelineMeta } from '../../../lib/actor';
import { fail, failFromManager, ok } from '../../../lib/envelope';
import { parseManagerMessage, readJson } from '../../../lib/validate';
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
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const parsed = parseManagerMessage(body.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.sendManagerMessage(id, parsed.value, await timelineMeta(req, backend));
  if (!res.ok) {
    if (
      res.error === TMUX_MISSING ||
      res.error === MANAGER_CARRIER_MISSING ||
      res.error === PTY_CARRIER_MISSING
    ) {
      return fail('backend_unavailable', res.error);
    }
    return failFromManager(res);
  }
  return ok({ delivered: res.delivered, manager: res.manager, event: res.event });
}
