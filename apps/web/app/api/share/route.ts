import { revalidatePath } from 'next/cache';
import { handleSharePost } from '@/lib/share/post';
import { db } from '@/lib/share/store';

export const runtime = 'nodejs';

export function POST(req: Request): Promise<Response> {
  return handleSharePost(req, {
    sql: db(),
    ipSalt: process.env.SHARE_IP_SALT,
    onStored: (handle, n) => {
      // The pages are cached forever; a share is new content at a path that may have
      // been cached as a 404 before it existed, and the handle's list gains a row.
      revalidatePath(`/u/${handle}/${n}`);
      revalidatePath(`/u/${handle}`);
    },
  });
}
