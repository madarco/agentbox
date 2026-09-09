'use client';

/**
 * Renders one create-time prompt the hub asked for.
 *
 * Two halves, deliberately. The generic half (title, body, choice buttons) can
 * render ANY prompt, including a topic this build has never heard of — which is
 * what lets the hub add a gate without shipping a new UI. The typed half draws
 * the variants worth drawing properly: a `carry:` file table, a credential card.
 * An unrecognised `detail` falls back to its `summary`, which every variant
 * carries for exactly this reason.
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Structural mirrors of @agentbox/core's prompt schema. Spelled locally for the
// same reason the rest of this app does it: a VALUE import of an @agentbox/*
// package pulls it into the Next bundle.
export interface PromptChoice {
  value: string;
  label: string;
  hint?: string;
  danger?: boolean;
}

export interface PromptFileRow {
  src: string;
  dest: string;
  bytes?: number;
  kind: 'file' | 'dir' | 'missing';
  mode?: string;
  user?: number;
  flags: string[];
  warn?: boolean;
}

export type PromptDetail =
  | { type: 'file-table'; summary: string; rows: PromptFileRow[]; totalBytes: number }
  | {
      type: 'credential';
      summary: string;
      agent: string;
      label: string;
      caveat?: string;
      hostPath: string;
      boxPath: string;
      bytes?: number;
    }
  | { type: string; summary: string };

export interface PromptRequest {
  id: string;
  topic: string;
  kind: 'confirm' | 'select' | 'text';
  title: string;
  body?: string;
  choices?: PromptChoice[];
  defaultValue?: string;
  detail?: PromptDetail;
  fallback: { value: string; reason: string };
  required?: boolean;
  nonInteractiveHint?: string;
}

export function PromptView({
  request,
  onAnswer,
  disabled,
}: {
  request: PromptRequest;
  onAnswer: (value: string) => void;
  disabled?: boolean;
}) {
  const choices = request.choices ?? defaultChoices(request);
  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="text-sm font-semibold text-amber-200">{request.title}</div>
      {request.body ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{request.body}</p>
      ) : null}

      <DetailView detail={request.detail} />

      <div className="flex flex-wrap gap-2 pt-1">
        {choices.map((c) => (
          <Button
            key={c.value}
            type="button"
            variant={c.value === request.defaultValue && !c.danger ? 'default' : 'outline'}
            disabled={disabled}
            title={c.hint}
            onClick={() => onAnswer(c.value)}
            className={cn(c.danger && 'text-red-400 hover:text-red-300')}
          >
            {c.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function DetailView({ detail }: { detail?: PromptDetail }) {
  if (!detail) return null;

  if (detail.type === 'file-table' && 'rows' in detail) {
    return (
      <div className="overflow-x-auto rounded border border-border/60">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">Host</th>
              <th className="px-2 py-1 font-medium">In the box</th>
              <th className="px-2 py-1 text-right font-medium">Size</th>
              <th className="px-2 py-1 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {detail.rows.map((r) => (
              <tr
                key={`${r.src}->${r.dest}`}
                className={cn('border-t border-border/40', r.warn && 'bg-red-500/10')}
              >
                <td className="px-2 py-1 break-all">{r.src}</td>
                <td className="px-2 py-1 break-all">{r.dest}</td>
                <td className="px-2 py-1 text-right whitespace-nowrap text-muted-foreground">
                  {r.kind === 'missing' ? '—' : formatBytes(r.bytes ?? 0)}
                </td>
                <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                  {rowFlags(r).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (detail.type === 'credential' && 'hostPath' in detail) {
    return (
      <div className="space-y-1 rounded border border-border/60 bg-muted/20 p-3 text-xs">
        <div className="font-medium">{detail.label}</div>
        <div className="font-mono break-all text-muted-foreground">
          {detail.hostPath} <span className="px-1">→</span> {detail.boxPath}
        </div>
        {detail.caveat ? <div className="pt-1 text-amber-300">{detail.caveat}</div> : null}
      </div>
    );
  }

  // Unknown variant (a newer hub than this UI): every detail carries a plain
  // `summary` precisely so this path still shows the user something correct.
  return (
    <pre className="overflow-x-auto rounded border border-border/60 bg-muted/20 p-3 font-mono text-xs">
      {detail.summary}
    </pre>
  );
}

/** A `confirm` (or a malformed `select`) still needs buttons to press. */
function defaultChoices(request: PromptRequest): PromptChoice[] {
  if (request.kind === 'confirm') {
    return [
      { value: 'y', label: 'Yes' },
      { value: 'n', label: 'No' },
    ];
  }
  return [{ value: request.fallback.value, label: 'Continue' }];
}

function rowFlags(r: PromptFileRow): string[] {
  const out = [...r.flags];
  if (r.mode) out.push(`mode ${r.mode}`);
  if (r.user !== undefined) out.push(`user ${String(r.user)}`);
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${units[i]}`;
}
