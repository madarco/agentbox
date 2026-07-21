'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OpenInApp, OpenTargets } from '@/lib/boxes/backend-types';
import type { Box } from '@/lib/boxes/types';
import { SectionLabel } from './section-label';

// Display order + labels for the host "open in" apps (mirrors the tray's Open In
// menu and the CLI's OPEN_IN_APPS). Codex gets its glyph; the terminal
// multiplexers share the terminal icon; VS Code/Cursor uses the external glyph;
// Finder (sshfs-mount /workspace + reveal) uses the folder glyph and is gated to
// SSH-capable providers via its `providers` in the open-targets report.
const APPS: { app: OpenInApp; label: string; icon: keyof typeof Icons }[] = [
  { app: 'claude', label: 'Claude', icon: 'claude' },
  { app: 'codex', label: 'Codex', icon: 'codex' },
  { app: 'vscode', label: 'VS Code', icon: 'ext' },
  { app: 'cmux', label: 'cmux', icon: 'terminal' },
  { app: 'herdr', label: 'Herdr', icon: 'terminal' },
  { app: 'iterm2', label: 'iTerm2', icon: 'terminal' },
  { app: 'finder', label: 'Finder', icon: 'folder' },
];

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. non-secure context) — no-op; the URL still opens via the button.
    }
  }, [url]);
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Icons.check /> : <Icons.copy />}
      {copied ? 'Copied' : 'Copy URL'}
    </Button>
  );
}

// Wraps a disabled control so the reason surfaces on hover, instantly (the
// Tooltip defaults to 0 delay). The trigger is a span because Button's
// `disabled:pointer-events-none` would swallow the hover on the button itself.
function DisabledTip({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-not-allowed">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

// Launch the box in a host app by POSTing to the open endpoint (which re-shells
// `agentbox open --in <app>`). Availability comes from the host probe
// (`/api/v1/open-targets`); every app is always listed, but disabled — with the
// why as a hover tooltip — when not installed or not eligible for this box's
// provider (e.g. Codex needs persistent SSH, so docker/hetzner only).
function useOpenIn(box: Box) {
  const [targets, setTargets] = useState<OpenTargets | null>(null);
  const [pending, setPending] = useState<OpenInApp | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/api/v1/open-targets', { credentials: 'same-origin' });
        if (alive) setTargets(r.ok ? ((await r.json()) as OpenTargets) : null);
      } catch {
        if (alive) setTargets(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const launch = useCallback(
    async (app: OpenInApp) => {
      setPending(app);
      try {
        const r = await fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/open`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app }),
        });
        if (!r.ok) {
          const detail = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
          window.alert(`Open in ${app} failed: ${detail?.error?.message ?? `HTTP ${r.status}`}`);
        }
      } catch (err) {
        window.alert(`Open in ${app} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPending(null);
      }
    },
    [box.id],
  );

  const report = targets?.supported ? targets.targets : null;
  const apps = report
    ? APPS.map(({ app, label, icon }) => {
        const info = report[app];
        const disabledReason = !info.available
          ? (info.reason ?? `${label} is not installed`)
          : info.providers && !info.providers.includes(box.provider)
            ? `Not available for ${box.provider} boxes`
            : null;
        return { app, label, icon, disabledReason };
      })
    : [];

  // False on a remote/non-mac hub (or probe failure) — host apps don't apply
  // there at all, so the Apps row hides instead of rendering all-disabled noise.
  const supported = report !== null;

  return { apps, supported, pending, launch };
}

export function Access({ box }: { box: Box }) {
  const { webUrl, vncUrl } = box;
  const { apps, supported, pending, launch } = useOpenIn(box);

  // Missing-URL reasons for the disabled Open web / Open VNC buttons.
  const unreachableReason =
    box.status === 'paused'
      ? 'Box is paused — resume to access'
      : box.status === 'stopped'
        ? 'Box is stopped — start to access'
        : null;
  const webReason = webUrl ? null : (unreachableReason ?? 'No web service exposed');
  const vncReason = vncUrl
    ? null
    : box.vncEnabled === false
      ? 'VNC is not enabled for this box'
      : (unreachableReason ?? 'VNC is not available');

  // Hosted/remote profile with no reachable endpoint: everything would render
  // permanently disabled — hide the card instead.
  if (!supported && !webUrl && !vncUrl) return null;

  return (
    <>
      <SectionLabel>Access</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
          <div className="min-w-[150px] flex-1">
            <div className="text-[13.5px] font-medium">{webUrl || !vncUrl ? 'Web' : 'VNC'}</div>
            <div className="mt-0.5 break-all font-mono text-[11.5px] text-muted-foreground">
              {webUrl ?? (vncUrl ? 'Remote desktop' : webReason)}
            </div>
          </div>
          <div className="flex flex-none flex-wrap gap-1.5">
            {webUrl ? (
              <Button variant="outline" size="sm" href={webUrl} target="_blank" rel="noreferrer">
                <Icons.ext />
                Open web
              </Button>
            ) : (
              <DisabledTip reason={webReason}>
                <Button variant="outline" size="sm" disabled>
                  <Icons.ext />
                  Open web
                </Button>
              </DisabledTip>
            )}
            {webUrl ? <CopyButton url={webUrl} /> : null}
            {vncUrl ? (
              <Button
                variant="outline"
                size="sm"
                href={vncUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  // Fire-and-forget prep: point the in-box browser at the web
                  // app so the VNC desktop isn't a blank X screen. The link
                  // opens synchronously (no popup-blocker risk); Chromium
                  // appears in the view a moment later.
                  void fetch(`/api/v1/boxes/${encodeURIComponent(box.id)}/screen`, {
                    method: 'POST',
                    credentials: 'same-origin',
                  }).catch(() => {});
                }}
              >
                <Icons.ext />
                Open VNC
              </Button>
            ) : (
              <DisabledTip reason={vncReason}>
                <Button variant="outline" size="sm" disabled>
                  <Icons.ext />
                  Open VNC
                </Button>
              </DisabledTip>
            )}
          </div>
        </div>
        {supported ? (
          <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
            <div className="min-w-[150px] flex-1">
              <div className="text-[13.5px] font-medium">Apps</div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">Open the box project from the host</div>
            </div>
            <div className="flex flex-none flex-wrap justify-end gap-1.5">
              {apps.map(({ app, label, icon, disabledReason }) => {
                const Icon = Icons[icon];
                return (
                  <DisabledTip key={app} reason={disabledReason}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabledReason !== null || pending !== null}
                      onClick={() => void launch(app)}
                    >
                      <Icon />
                      {label}
                    </Button>
                  </DisabledTip>
                );
              })}
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
