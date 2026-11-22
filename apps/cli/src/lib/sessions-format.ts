// Pure helpers behind `agentbox sessions`: no hub, no fs, so they unit-test.
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { HubApiHistorySession, HubApiHistoryTurn } from '../control-plane/hub-api-client.js';

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function clip(text: string | null | undefined, max: number): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** `2026-11-22 18:14` in local time, or `-`. */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sessionRow(s: HubApiHistorySession): string[] {
  return [
    shortId(s.id),
    s.agent,
    s.boxName ?? s.boxId ?? '-',
    s.provider ?? '-',
    String(s.turns),
    `${compactCount(s.inputTokens)}/${compactCount(s.outputTokens)}`,
    shortTime(s.lastTs ?? s.updatedAt),
    clip(s.title, 60),
  ];
}

export const SESSION_HEADERS = [
  'ID',
  'AGENT',
  'BOX',
  'PROVIDER',
  'TURNS',
  'TOKENS IN/OUT',
  'LAST',
  'TITLE',
];

/** One condensed transcript line. */
export function turnLine(t: HubApiHistoryTurn, max = 400): string {
  const sub = t.path.includes('/subagents/') ? ' (subagent)' : '';
  if (t.kind === 'tool') return `    · ${t.name ?? 'tool'}${sub}`;
  return `${t.role === 'user' ? '>' : '<'} ${clip(t.text, max)}${sub}`;
}

/**
 * Where a downloaded file goes: `<dir>/<sessionId>/<path>`, refusing anything
 * that would land outside that folder (the hub validates paths at ingest; this
 * does not trust it to).
 */
export function downloadTarget(dir: string, sessionId: string, path: string): string | null {
  if (!/^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/.test(sessionId)) return null;
  if (isAbsolute(path)) return null;
  const root = resolve(dir, sessionId);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return join(root, rel);
}
