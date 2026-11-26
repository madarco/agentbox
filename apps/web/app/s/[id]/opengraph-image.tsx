import { notFound } from 'next/navigation';
import { loadShare } from '@/lib/share/load';
import { OG_ALT, OG_SIZE, renderShareOg } from '@/lib/share/og';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stored = await loadShare(id);
  if (!stored) notFound();
  return renderShareOg(stored.share);
}
