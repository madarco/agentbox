import { source } from '@/lib/source';
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getMDXComponents } from '@/mdx-components';
import { SITE } from '@/lib/site';

// The sidebar groups are flat `---Label---` separators in meta.json, so the page
// tree is a flat list. A page's group is the nearest separator that precedes it.
function groupForUrl(url: string): string | undefined {
  let current: string | undefined;
  for (const node of source.pageTree.children) {
    if (node.type === 'separator') {
      current = typeof node.name === 'string' ? node.name : undefined;
    } else if (node.type === 'page' && node.url === url) {
      return current;
    }
  }
  return current;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const group = groupForUrl(page.url);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <nav className="agb-crumbs" aria-label="Breadcrumb">
        <a href="/docs">Docs</a>
        {group ? (
          <>
            <span className="sep">/</span>
            <span>{group}</span>
          </>
        ) : null}
        <span className="sep">/</span>
        <span className="cur">{page.data.title}</span>
      </nav>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const title = page.data.title;
  const description = page.data.description;

  // Per-page dynamic OG image, served by app/docs-og/[...slug]/route.tsx. The
  // URL mirrors the shape produced by that route's generateStaticParams (the
  // page slug plus a synthetic "image.png" segment). metadataBase resolves it
  // to an absolute URL for the tags.
  const ogUrl = `/docs-og/${[...(params.slug ?? []), 'image.png'].join('/')}`;

  // Re-specify siteName + image: Next shallowly merges the `openGraph`/`twitter`
  // keys, so a page-level object replaces the root defaults rather than deep-
  // merging into them.
  return {
    title,
    description,
    alternates: { canonical: page.url },
    openGraph: {
      type: 'article',
      siteName: SITE.name,
      url: `${SITE.url}${page.url}`,
      title,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
      creator: SITE.twitterCreator,
    },
  };
}
