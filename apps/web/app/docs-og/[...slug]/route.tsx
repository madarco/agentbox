import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { OG, boxMark, loadOgFonts } from '@/lib/og';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  // slug ends in the synthetic "image.png" segment (see generateStaticParams).
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const fonts = await loadOgFonts();

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: '80px',
          backgroundColor: OG.paper,
          fontFamily: 'IBM Plex Sans',
          borderBottom: `20px solid ${OG.accent}`,
        }}
      >
        <div
          style={{
            fontSize: 82,
            fontWeight: 600,
            color: OG.ink,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          {page.data.title}
        </div>
        {page.data.description ? (
          <div
            style={{
              fontSize: 40,
              fontWeight: 400,
              color: OG.muted,
              marginTop: 28,
              lineHeight: 1.35,
            }}
          >
            {page.data.description}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            marginTop: 'auto',
            paddingTop: 36,
            borderTop: `2px solid ${OG.line}`,
          }}
        >
          {boxMark(OG.ink, 60)}
          <div
            style={{
              fontFamily: 'IBM Plex Mono',
              fontWeight: 600,
              fontSize: 40,
              color: OG.ink,
            }}
          >
            agentbox
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              marginLeft: 'auto',
            }}
          >
            <div style={{ fontSize: 26, color: OG.ink }}>
              One command teleport for agents, in parallel.
            </div>
            <div
              style={{
                fontFamily: 'IBM Plex Mono',
                fontSize: 22,
                color: OG.accent,
                marginTop: 6,
              }}
            >
              agent-box.sh/docs
            </div>
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: fonts.length ? fonts : undefined },
  );
}

export function generateStaticParams() {
  return source.generateParams().map((param) => ({
    ...param,
    slug: [...param.slug, 'image.png'],
  }));
}
