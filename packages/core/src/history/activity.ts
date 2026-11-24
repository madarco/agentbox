/**
 * The working-on line (docs/agent-live-status-plan.md, Phase 3): one line, at
 * most 120 chars, redacted. Tool inputs can carry secrets and whole files, so a
 * tool's line is built only from the short, named fields below, never from the
 * content of a write.
 */
import { createRedactor } from './redact.js';
import { asObject, nonEmptyString } from './jsonl.js';

export const ACTIVITY_MAX = 120;

const redactor = createRedactor();

/** Collapse to one line, redact, clip. Empty when nothing is left. */
export function activityLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  // Redact before clipping: a secret cut in half no longer matches its pattern.
  const red = Buffer.from(redactor.redact(Buffer.from(one, 'utf8')).bytes).toString('utf8');
  return red.length > ACTIVITY_MAX ? `${red.slice(0, ACTIVITY_MAX - 1)}…` : red;
}

/**
 * Input fields that describe a call without its payload, most telling first:
 * a human description, then a command, then the target.
 */
const DETAIL_KEYS = [
  'description',
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
] as const;

/** `<tool>: <detail>` for one tool call, or the bare tool name. */
export function toolActivity(name: string, input: unknown): string {
  const o = asObject(input);
  let detail: string | undefined;
  for (const k of DETAIL_KEYS) {
    const v = o?.[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      detail = nonEmptyString(v.join(' '));
    } else {
      detail = nonEmptyString(v);
    }
    if (detail) break;
  }
  return activityLine(detail ? `${name}: ${detail}` : name);
}
