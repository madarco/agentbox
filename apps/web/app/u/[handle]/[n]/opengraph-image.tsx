import { notFound } from 'next/navigation';
import { loadShare } from '@/lib/share/load';
import { OG_ALT, OG_SIZE, renderShareOg } from '@/lib/share/og';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({
  params,
}: {
  params: Promise<{ handle: string; n: string }>;
}) {
  const { handle, n } = await params;
  const stored = await loadShare(handle, n);
  if (!stored) notFound();
  return renderShareOg(stored.share);
}
