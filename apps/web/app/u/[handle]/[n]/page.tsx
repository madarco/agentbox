import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShareView } from '@/components/share-view';
import { dateDay, shareMeta } from '@/lib/share/format';
import { loadShare } from '@/lib/share/load';

// A share never changes: render on first request and keep it. POST /api/share
// revalidates the path when the share is created.
export const revalidate = false;
export const dynamicParams = true;
export function generateStaticParams(): { handle: string; n: string }[] {
  return [];
}

type Props = { params: Promise<{ handle: string; n: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, n } = await params;
  const stored = await loadShare(handle, n);
  if (!stored) return {};
  const { title, description } = shareMeta(stored.share);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/u/${handle}/${n}` },
    openGraph: { type: 'website', title, description, url: `/u/${handle}/${n}` },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function SharePage({ params }: Props) {
  const { handle, n } = await params;
  const stored = await loadShare(handle, n);
  if (!stored) notFound();
  return <ShareView share={stored.share} sharedOn={dateDay(stored.createdAt)} />;
}
