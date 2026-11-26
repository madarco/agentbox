import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShareHeader } from '@/components/share-header';
import { dateDay, num, peakText, rangeText, speedup } from '@/lib/share/format';
import { validHandle } from '@/lib/share/params';
import { db, listShares } from '@/lib/share/store';

// Revalidated by POST /api/share whenever this handle gains a share.
export const revalidate = false;
export const dynamicParams = true;
export function generateStaticParams(): { handle: string }[] {
  return [];
}

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  return { title: { absolute: `${handle}'s agents on AgentBox` } };
}

export default async function HandlePage({ params }: Props) {
  const { handle } = await params;
  const sql = db();
  if (!validHandle(handle) || !sql) notFound();
  const { shares, more } = await listShares(sql, handle);
  if (shares.length === 0) notFound();
  return (
    <>
      <ShareHeader>
        <span className="text-fd-foreground">{handle}</span> · {shares.length}
        {more ? '+' : ''} {shares.length === 1 ? 'share' : 'shares'}
      </ShareHeader>
      <div className="mx-auto w-full max-w-[1240px] px-6 py-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">{handle}&apos;s agents</h1>
        <ul className="divide-y divide-fd-border overflow-hidden rounded-xl border border-fd-border bg-fd-card">
          {shares.map(({ n, share, createdAt }) => (
            <li key={n}>
              <Link
                href={`/u/${handle}/${n}`}
                className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4 hover:bg-fd-accent"
              >
                <span className="w-32 shrink-0 font-mono text-[13px] text-fd-muted-foreground">
                  {dateDay(createdAt)}
                </span>
                <span className="font-semibold">{peakText(share)}</span>
                <span>
                  {num(share.hero.agentHours)} h of work in {num(share.hero.wallHours)} h ·{' '}
                  {speedup(share.hero.speedup)}
                </span>
                <span className="text-fd-muted-foreground">
                  {num(share.hero.prsMerged)} PRs merged · {num(share.hero.commits)} commits
                </span>
                <span className="ml-auto font-mono text-[12px] text-fd-muted-foreground">
                  {rangeText(share)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
