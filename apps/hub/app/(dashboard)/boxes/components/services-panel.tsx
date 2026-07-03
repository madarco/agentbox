'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { restartServiceAction } from '@/lib/boxes/actions';
import type { ServicesResult, ServiceView } from '@/lib/boxes/backend-types';
import { cn } from '@/lib/utils';
import { SectionLabel } from './section-label';

// Service states that mean "up", "warming/idle", and "broken" — drives the colour.
const UP = new Set(['ready', 'running', 'done']);
const BAD = new Set(['crashed', 'unhealthy', 'backoff', 'failed']);

type Tone = 'up' | 'bad' | 'idle';
function tone(state: string): Tone {
  if (UP.has(state)) return 'up';
  if (BAD.has(state)) return 'bad';
  return 'idle';
}
const DOT: Record<Tone, string> = {
  up: 'bg-[var(--green)]',
  bad: 'bg-[var(--red)]',
  idle: 'bg-[var(--amber)]',
};
const TEXT: Record<Tone, string> = {
  up: 'text-[var(--green-ink)]',
  bad: 'text-[var(--red)]',
  idle: 'text-[var(--amber)]',
};

function ServiceRow({
  svc,
  disabled,
  onRestart,
}: {
  svc: ServiceView;
  disabled: boolean;
  onRestart: (name: string) => void;
}) {
  const t = tone(svc.state);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={cn('badge-dot', DOT[t])} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-secondary-foreground">{svc.name}</span>
      <span className={cn('font-mono text-xs', TEXT[t])}>{svc.state}</span>
      {svc.restarts > 0 ? (
        <span className="font-mono text-[11px] text-muted-foreground">↻{svc.restarts}</span>
      ) : null}
      <Button
        variant="outline"
        size="icon-sm"
        title={`Restart ${svc.name}`}
        disabled={disabled}
        onClick={() => onRestart(svc.name)}
      >
        <Icons.play />
      </Button>
    </div>
  );
}

export function ServicesPanel({ id, running }: { id: string; running: boolean }) {
  const [data, setData] = useState<ServicesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/boxes/${encodeURIComponent(id)}/services`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError(`status ${String(res.status)}`);
        return;
      }
      setData((await res.json()) as ServicesResult);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  // Poll while the box is running (services change state); one-shot otherwise.
  useEffect(() => {
    void load();
    if (!running) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load, running]);

  const restart = (name?: string) => {
    startTransition(async () => {
      const res = await restartServiceAction(id, name);
      if (!res.ok) window.alert(`Restart failed: ${res.error}`);
      await load();
    });
  };

  const services = data?.services ?? [];
  const hasServices = services.length > 0;

  return (
    <>
      <SectionLabel
        right={
          hasServices ? (
            <Button variant="outline" size="sm" disabled={!running || pending} onClick={() => restart(undefined)}>
              <Icons.play />
              Restart all
            </Button>
          ) : null
        }
      >
        Services
      </SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {!data && !error ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">Could not load services ({error}).</div>
        ) : !hasServices ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            {data?.source === 'unavailable'
              ? 'No service status (box not running or no snapshot yet).'
              : 'No services declared in agentbox.yaml.'}
          </div>
        ) : (
          <>
            {data?.source === 'persisted' ? (
              <div className="bg-muted/30 px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
                persisted snapshot — box not running
              </div>
            ) : null}
            {services.map((svc) => (
              <ServiceRow key={svc.name} svc={svc} disabled={!running || pending} onRestart={(n) => restart(n)} />
            ))}
          </>
        )}
      </Card>
    </>
  );
}
