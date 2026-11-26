import { handleSharePost } from '@/lib/share/post';
import { db } from '@/lib/share/store';
import { revalidateShare } from './revalidate';

export const runtime = 'nodejs';

export function POST(req: Request): Promise<Response> {
  return handleSharePost(req, {
    sql: db(),
    ipSalt: process.env.SHARE_IP_SALT,
    onChanged: revalidateShare,
  });
}
