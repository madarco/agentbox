'use client';

// `accounts.onLimit` (hub settings 3c): what the hub does when a running box's
// account reaches its plan limit.
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type OnLimit = 'ask' | 'switch';

const CHOICES: Array<{ value: OnLimit; title: string; text: string }> = [
  {
    value: 'ask',
    title: 'Ask me',
    text: 'Raise an approval offering the next account of the same agent. Answer it here, in the tray or in the CLI.',
  },
  {
    value: 'switch',
    title: 'Switch on its own',
    text: 'Move the box to the next account of the same agent that is not at its limit.',
  },
];

export function LimitPolicyCard() {
  const [value, setValue] = useState<OnLimit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/accounts/policy', { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? ((await r.json()) as { onLimit: OnLimit }) : null))
      .then((j) => {
        if (alive && j) setValue(j.onLimit);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const choose = async (next: OnLimit) => {
    if (next === value || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/v1/accounts/policy', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onLimit: next }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `HTTP ${String(r.status)}`);
        return;
      }
      setValue(((await r.json()) as { onLimit: OnLimit }).onLimit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden p-5">
      <div className="text-[14.5px] font-semibold">
        When a box&apos;s subscription hits its limit
      </div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
        A setup token or API key restarts the agent on it; a login is written into the box and
        Claude keeps running. The conversation carries on either way.
      </div>
      <div
        role="radiogroup"
        aria-label="When a subscription hits its limit"
        className="mt-4 grid gap-2.5 sm:grid-cols-2"
      >
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={value === c.value}
            disabled={value === null || saving}
            onClick={() => void choose(c.value)}
            className={cn(
              'flex cursor-pointer flex-col items-start justify-start rounded-lg border p-3.5 text-left transition-colors disabled:cursor-default',
              value === c.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-secondary/60',
            )}
          >
            <div className="text-[13.5px] font-medium">{c.title}</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">{c.text}</div>
          </button>
        ))}
      </div>
      {error ? <div className="mt-3 text-[12.5px] text-destructive">{error}</div> : null}
    </Card>
  );
}
