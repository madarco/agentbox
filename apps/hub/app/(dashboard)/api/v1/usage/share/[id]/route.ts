// DELETE /api/v1/usage/share/<id> — remove one of this hub's usage shares from the
// site that holds it (with the delete secret kept in share.json), then forget it.
// Returns { id, deleted }: `deleted: false` when the site no longer had it.
import { deleteUsageShare } from '@/lib/backend/usage-share';
import { ok } from '../../../lib/envelope';
import { failShare, shareStore } from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    return ok(await deleteUsageShare({ store: shareStore }, id));
  } catch (e) {
    return failShare(e);
  }
}
