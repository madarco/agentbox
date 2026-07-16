import { ImageResponse } from 'next/og';
import { OG, boxMark, cubeMark, loadOgFonts, localPng, simpleIcon } from '@/lib/og';

// A themed recreation of the home-page hero (macOS menu-bar tray + terminal),
// so a shared link to agent-box.sh matches the site instead of the README png.
// Served at /home-og/image.png; public/home.html's OG meta tags point here.

// Content is fixed, so prerender the image at build time and serve it cached.
export const dynamic = 'force-static';

const mono = 'IBM Plex Mono';
const sans = 'IBM Plex Sans';

function FolderIcon({ color }: { color: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function GlobeIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
    </svg>
  );
}

function BoxRow({ name, sub }: { name: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px' }}>
      <div style={{ display: 'flex', width: 11, height: 11, borderRadius: 11, backgroundColor: OG.accent }} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontFamily: sans, fontWeight: 600, fontSize: 21, color: OG.ink }}>{name}</div>
        <div style={{ fontFamily: mono, fontSize: 15, color: OG.muted, marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 22, color: OG.faint }}>›</div>
    </div>
  );
}

function FolderRow({ name }: { name: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px' }}>
      <FolderIcon color={OG.faint} />
      <div style={{ fontFamily: sans, fontSize: 18, color: OG.muted }}>{name}</div>
    </div>
  );
}

function MenuRow({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 16px' }}>
      <GlobeIcon color={OG.muted} />
      <div style={{ fontFamily: sans, fontSize: 19, color: OG.ink }}>{label}</div>
    </div>
  );
}

const TERM_LINES: { text: string; color: string }[] = [
  { text: '$ agentbox vercel codex', color: OG.accent },
  { text: '• provisioning box on vercel…', color: OG.termFaint },
  { text: '✓ box 2 ready · codex', color: OG.accent },
  { text: '', color: OG.termText },
  { text: '$ agentbox codex attach 2', color: OG.accent },
  { text: '> reattaching to running box', color: OG.termFaint },
  { text: '✓ resumed codex on box 2', color: OG.accent },
];

// Small labelled icon+text used in the bottom logos strip.
function LogoItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      {icon}
      <div style={{ fontFamily: sans, fontSize: 22, color: OG.ink }}>{label}</div>
    </div>
  );
}

function iconImg(src: string | null, size = 24): React.ReactNode {
  if (!src) return <div style={{ display: 'flex', width: size, height: size }} />;
  return <img src={src} width={size} height={size} style={{ objectFit: 'contain' }} />;
}

export async function GET() {
  const [fonts, docker, vercel, hetzner, digitalocean, claude, codex, opencode] =
    await Promise.all([
      loadOgFonts(),
      simpleIcon('docker'),
      simpleIcon('vercel'),
      simpleIcon('hetzner'),
      simpleIcon('digitalocean'),
      localPng('assets/agent-claude.png'),
      localPng('assets/agent-codex.png'),
      localPng('assets/agent-opencode.png'),
    ]);

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: '46px 64px 30px',
          backgroundColor: OG.paper,
          fontFamily: sans,
          borderBottom: `20px solid ${OG.accent}`,
        }}
      >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flex: 1, gap: 40 }}>
        {/* Left: wordmark + headline + lede + install chip */}
        <div style={{ display: 'flex', flexDirection: 'column', width: 470 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
            {boxMark(OG.ink, 38)}
            <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 29, color: OG.ink }}>agentbox</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 52, fontWeight: 600, color: OG.ink, lineHeight: 1.08, letterSpacing: '-0.02em' }}>
            <div style={{ display: 'flex' }}>One command teleport</div>
            <div style={{ display: 'flex', color: OG.faint }}>for agents, in parallel.</div>
          </div>
          <div style={{ fontSize: 23, color: OG.muted, marginTop: 20, lineHeight: 1.4 }}>
            Isolated, checkpointed VMs — local or in the cloud.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              alignSelf: 'flex-start',
              marginTop: 24,
              padding: '12px 18px',
              backgroundColor: OG.panel,
              border: `1px solid ${OG.line}`,
              borderRadius: 10,
              fontFamily: mono,
              fontSize: 21,
            }}
          >
            <span style={{ color: OG.accent }}>npx&nbsp;</span>
            <span style={{ color: OG.ink }}>@madarco/agentbox claude</span>
          </div>
        </div>

        {/* Right: the desktop scene — menu bar + tray dropdown + terminal */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            width: 560,
            height: 406,
            backgroundColor: OG.paper,
            border: `1px solid ${OG.line}`,
            borderRadius: 16,
            overflow: 'hidden',
          }}
        >
          {/* menu bar */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 14,
              padding: '0 16px',
              backgroundColor: '#eeeeea',
              borderBottom: `1px solid ${OG.line}`,
            }}
          >
            <div style={{ display: 'flex', padding: 4, borderRadius: 6, backgroundColor: '#dcdcd6' }}>{boxMark(OG.ink, 20)}</div>
            <div style={{ fontFamily: mono, fontSize: 15, color: OG.muted }}>Thu Jul 9  9:41 AM</div>
          </div>

          {/* terminal window */}
          <div
            style={{
              position: 'absolute',
              left: 22,
              bottom: 22,
              width: 322,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: OG.term,
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 18px 40px -12px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px', backgroundColor: '#15171b' }}>
              <div style={{ display: 'flex', width: 11, height: 11, borderRadius: 11, backgroundColor: '#ff5f57' }} />
              <div style={{ display: 'flex', width: 11, height: 11, borderRadius: 11, backgroundColor: '#febc2e' }} />
              <div style={{ display: 'flex', width: 11, height: 11, borderRadius: 11, backgroundColor: '#28c840' }} />
              <div style={{ fontFamily: mono, fontSize: 14, color: OG.termFaint, marginLeft: 8 }}>agentbox — zsh</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', padding: '14px 16px', gap: 6 }}>
              {TERM_LINES.map((l, i) => (
                <div key={i} style={{ display: 'flex', fontFamily: mono, fontSize: 15, color: l.color, height: 19 }}>
                  {l.text}
                </div>
              ))}
              <div style={{ display: 'flex', fontFamily: mono, fontSize: 15, marginTop: 2 }}>
                <span style={{ color: '#6ea8fe' }}>user@box-2:~/workspace$</span>
                <span style={{ color: OG.accent }}>&nbsp;▏</span>
              </div>
            </div>
          </div>

          {/* tray dropdown */}
          <div
            style={{
              position: 'absolute',
              right: 18,
              top: 30,
              width: 288,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: OG.panel,
              border: `1px solid ${OG.line}`,
              borderRadius: 14,
              paddingTop: 6,
              paddingBottom: 6,
              boxShadow: '0 22px 50px -14px rgba(0,0,0,0.28)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px 12px' }}>
              <div style={{ fontFamily: sans, fontWeight: 600, fontSize: 23, color: OG.ink }}>AgentBox</div>
              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  backgroundColor: OG.accent,
                  borderRadius: 8,
                  color: '#ffffff',
                  fontFamily: sans,
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                + New Box
              </div>
            </div>
            <div style={{ display: 'flex', height: 1, backgroundColor: OG.line, margin: '0 12px' }} />
            <FolderRow name="storefront-web" />
            <BoxRow name="payment-retries" sub="codex · vercel" />
            <FolderRow name="docs-site" />
            <BoxRow name="search-filters" sub="claude · vercel" />
            <div style={{ display: 'flex', height: 1, backgroundColor: OG.line, margin: '6px 12px' }} />
            <MenuRow label="Open Hub" />
          </div>
        </div>
      </div>

        {/* Logos strip: clouds + agents (mirrors the home "works with" row) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 26, paddingTop: 22, borderTop: `1px solid ${OG.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
            <div style={{ fontFamily: mono, fontSize: 18, color: OG.faint, width: 84 }}>clouds</div>
            <LogoItem icon={iconImg(docker)} label="Docker" />
            <LogoItem icon={iconImg(vercel)} label="Vercel" />
            <LogoItem icon={iconImg(hetzner)} label="Hetzner" />
            <LogoItem icon={iconImg(digitalocean)} label="DigitalOcean" />
            <LogoItem icon={cubeMark(OG.ink, 22)} label="Daytona" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
            <div style={{ fontFamily: mono, fontSize: 18, color: OG.faint, width: 84 }}>agents</div>
            <LogoItem icon={iconImg(claude)} label="Claude Code" />
            <LogoItem icon={iconImg(codex)} label="Codex" />
            <LogoItem icon={iconImg(opencode)} label="OpenCode" />
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: fonts.length ? fonts : undefined },
  );
}
