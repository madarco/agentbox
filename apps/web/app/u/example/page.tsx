import type { Metadata } from 'next';
import { ShareView } from '@/components/share-view';
import { longDay, shareMeta } from '@/lib/share/format';
import { exampleShare } from './share';

export const dynamic = 'force-static';

const share = exampleShare();
const { title, description } = shareMeta(share);

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: '/u/example' },
  openGraph: { type: 'website', title, description, url: '/u/example' },
  twitter: { card: 'summary_large_image', title, description },
};

export default function ExamplePage() {
  return <ShareView share={share} sharedOn={longDay(share.range.today)} />;
}
