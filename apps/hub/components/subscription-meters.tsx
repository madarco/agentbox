'use client';

// The pieces a subscription is drawn with, on the Subscriptions page and in
// the top bar's meter (design: control-shadcn/views-env.jsx). One meter per
// limit window the account reports; none is ever invented.

import { agentIcon, Icons, type Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { agoText, resetText, type Account } from '@/lib/accounts-client';
import { vendorOf } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';

export const toneOf = (pct: number): string =>
  pct >= 100 ? 'bg-[var(--red)]' : pct >= 80 ? 'bg-[var(--amber)]' : 'bg-primary';

export function Meter({
  label,
  value,
  pct,
  sub,
}: {
  label: string;
  value: string;
  pct: number;
  sub?: string;
}) {
  const full = pct >= 100;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-secondary-foreground">{label}</span>
        <span className={cn('ml-auto font-mono font-medium', full && 'text-[var(--red)]')}>
          {value}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary"
        role="img"
        aria-label={`${label}: ${value}`}
      >
        <div
          className={cn('h-full rounded-full', toneOf(pct))}
          style={{ width: `${String(Math.min(100, Math.max(0, pct)))}%` }}
        />
      </div>
      {sub ? (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

const pctText = (pct: number): string =>
  pct >= 100 ? 'limit reached' : `${String(Math.round(pct))}%`;

/** The account's limit meters, or why there are none. */
export function SubMeters({ account: a, compact }: { account: Account; compact?: boolean }) {
  if (a.kind === 'api-key') {
    return <div className="font-mono text-[11px] text-muted-foreground">no plan limits</div>;
  }
  const windows = a.limits?.windows ?? [];
  if (windows.length === 0) {
    // Only the agents that report limits get a hint; for the others there is
    // nothing to wait for.
    const hint =
      a.agent === 'claude'
        ? 'limits appear while a box runs on it'
        : a.agent === 'codex'
          ? 'limits appear after its first session'
          : null;
    return hint ? <div className="font-mono text-[11px] text-muted-foreground">{hint}</div> : null;
  }
  return (
    <div>
      <div
        className={cn(
          'grid gap-4',
          compact || windows.length === 1
            ? 'grid-cols-1 gap-2.5'
            : 'grid-cols-2 max-sm:grid-cols-1',
        )}
      >
        {windows.map((w) => (
          <Meter
            key={w.id}
            label={w.label}
            value={pctText(w.pct)}
            pct={w.pct}
            sub={resetText(w.resetsAt)}
          />
        ))}
      </div>
      {a.limits ? <LimitsAge limits={a.limits} /> : null}
    </div>
  );
}

/** How old the values are; "stale" when the source has gone quiet. */
export function LimitsAge({ limits }: { limits: NonNullable<Account['limits']> }) {
  return (
    <div
      className={cn(
        'mt-2 font-mono text-[11px]',
        limits.stale ? 'text-[#6a4e0c]' : 'text-muted-foreground',
      )}
      title={
        limits.stale
          ? limits.source === 'transcript'
            ? 'No session on this account has reported newer values.'
            : 'The last reads of the usage endpoint failed; these are the last values it returned.'
          : undefined
      }
    >
      {limits.stale ? 'stale · ' : ''}
      {agoText(limits.updatedAt)}
    </div>
  );
}

/** The glyph a subscription is drawn with: its agent's brand mark, or a key. */
export function subGlyph(a: Pick<Account, 'agent' | 'kind'>): Icon {
  return agentIcon(a.agent, Icons.key);
}

export function SubMark({ account: a, className }: { account: Account; className?: string }) {
  const Glyph = subGlyph(a);
  return (
    <span
      className={cn(
        'grid size-[30px] flex-none place-items-center rounded-lg border border-border bg-background text-secondary-foreground',
        className,
      )}
    >
      <Glyph className="size-4" />
    </span>
  );
}

/** The plan tier, or the kind when the login reports none. */
export function TierBadge({ account: a }: { account: Account }) {
  const plan = a.identity?.plan;
  if (a.kind === 'api-key') {
    return <Badge className="px-1.5 py-0 text-[10.5px]">API key</Badge>;
  }
  if (!plan) {
    return (
      <Badge className="px-1.5 py-0 text-[10.5px]">
        {a.kind === 'setup-token' ? 'setup token' : 'login'}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="px-1.5 py-0 font-sans text-[10.5px]">
      {plan}
    </Badge>
  );
}

/** `Anthropic · dev@acme.example`, `OpenAI · API key · pay as you go`. */
export function subLine(a: Account): string {
  const vendor = vendorOf(a.agent);
  if (a.kind === 'api-key') return `${vendor} · API key · pay as you go`;
  const who = a.identity?.email ?? a.identity?.org;
  return `${vendor} · ${who ?? `${a.agent}/${a.id}`}`;
}

export function subName(a: Account): string {
  return a.label ?? (a.id === 'default' ? 'Default login' : a.id);
}
