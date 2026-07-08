'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { OpenInApp, OpenTargets } from '@/lib/boxes/backend-types';
import type { Box } from '@/lib/boxes/types';
import { SectionLabel } from './section-label';

// Display order + labels for the five host "open in" apps (mirrors the tray's
// Open In menu and the CLI's OPEN_IN_APPS). Codex gets its glyph; the terminal
// multiplexers share the terminal icon; VS Code/Cursor uses the external glyph.
const APPS: { app: OpenInApp; label: string; icon: keyof typeof Icons }[] = [
  { app: 'codex', label: 'Codex', icon: 'codex' },
  { app: 'vscode', label: 'VS Code', icon: 'ext' },
  { app: 'cmux', label: 'cmux', icon: 'terminal' },
  { app: 'herdr', label: 'Herdr', icon: 'terminal' },
  { app: 'iterm2', label: 'iTerm2', icon: 'terminal' },
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

// Launch the box in a host app by POSTing to the open endpoint (which re-shells
// `agentbox open --in <app>`). Availability comes from the host probe
// (`/api/v1/open-targets`); each app is offered only when installed AND eligible
// for this box's provider (e.g. Codex is Hetzner-only).
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
  const eligible = report
    ? APPS.filter(({ app }) => {
        const info = report[app];
        return info.available && (!info.providers || info.providers.includes(box.provider));
      })
    : [];

  return { eligible, pending, launch };
}

export function Access({ box }: { box: Box }) {
  const { webUrl, vncUrl } = box;
  const { eligible, pending, launch } = useOpenIn(box);

  // Nothing to show: no reachable web/VNC endpoint and no launchable host app.
  if (!webUrl && !vncUrl && eligible.length === 0) return null;

  return (
    <>
      <SectionLabel>Access</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {webUrl || vncUrl ? (
          <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
            <div className="min-w-[150px] flex-1">
              <div className="text-[13.5px] font-medium">{webUrl ? 'Web' : 'VNC'}</div>
              <div className="mt-0.5 break-all font-mono text-[11.5px] text-muted-foreground">{webUrl ?? 'Remote desktop'}</div>
            </div>
            <div className="flex flex-none flex-wrap gap-1.5">
              {webUrl ? (
                <Button variant="outline" size="sm" href={webUrl} target="_blank" rel="noreferrer">
                  <Icons.ext />
                  Open web
                </Button>
              ) : null}
              {webUrl ? <CopyButton url={webUrl} /> : null}
              {vncUrl ? (
                <Button variant="outline" size="sm" href={vncUrl} target="_blank" rel="noreferrer">
                  <Icons.ext />
                  Open VNC
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {eligible.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
            <div className="min-w-[150px] flex-1">
              <div className="text-[13.5px] font-medium">Apps</div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">Open the box in a host app</div>
            </div>
            <div className="flex flex-none flex-wrap justify-end gap-1.5">
              {eligible.map(({ app, label, icon }) => {
                const Icon = Icons[icon];
                return (
                  <Button
                    key={app}
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void launch(app)}
                  >
                    <Icon />
                    {label}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
