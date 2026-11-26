import { handleShareDelete } from '@/lib/share/post';
import { db } from '@/lib/share/store';
import { revalidateShare } from '../revalidate';

export const runtime = 'nodejs';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleShareDelete(req, id, { sql: db(), onChanged: revalidateShare });
}
