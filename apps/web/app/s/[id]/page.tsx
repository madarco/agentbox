import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShareView } from '@/components/share-view';
import { dateDay, shareMeta } from '@/lib/share/format';
import { loadShare } from '@/lib/share/load';

// A share never changes: render on first request and keep it. The share API
// revalidates the path when the share is created or deleted.
export const revalidate = false;
export const dynamicParams = true;
export function generateStaticParams(): { id: string }[] {
  return [];
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const stored = await loadShare(id);
  if (!stored) return {};
  const { title, description } = shareMeta(stored.share);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/s/${id}` },
    openGraph: { type: 'website', title, description, url: `/s/${id}` },
    twitter: { card: 'summary_large_image', title, description },
    // A share is reached by its link, not by search.
    robots: { index: false },
  };
}

export default async function SharePage({ params }: Props) {
  const { id } = await params;
  const stored = await loadShare(id);
  if (!stored) notFound();
  return <ShareView share={stored.share} sharedOn={dateDay(stored.createdAt)} />;
}
