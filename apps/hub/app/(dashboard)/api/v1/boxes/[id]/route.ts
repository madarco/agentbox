// GET /api/v1/boxes/:id — one box from the normalized view (404 if absent).
import { readState } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const { boxes } = await readState();
  const box = boxes.find((b) => b.id === id);
  if (!box) return fail('not_found', `box not found: ${id}`);
  return ok(box);
}
