/**
 * The working-on line (docs/agent-live-status-plan.md, Phase 3): one line, at
 * most 120 chars, redacted. Tool inputs can carry secrets and whole files, so a
 * tool's line is built only from the short, named fields below, never from the
 * content of a write, and a command shows only its program and first plain
 * argument (`commandSummary`): the redactor here knows no exact secrets, so a
 * heredoc body or an env value must never reach it in the first place.
 */
import { createRedactor, looksLikeSecretValue } from './redact.js';
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

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
/** Words that run the next word: skipped to reach the program. */
const PREFIXES = new Set(['sudo', 'env', 'exec', 'time', 'nohup', 'nice', 'command']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A program or argument shown as is: short, no quotes, spaces, `=` or `$`. */
const SAFE_WORD = /^(?:[A-Za-z0-9_][A-Za-z0-9._/:@%+,-]{0,39}|-{1,2}[A-Za-z][A-Za-z0-9-]{0,19})$/;

/**
 * The first simple command of a shell line: up to the first newline, heredoc,
 * pipe, list, redirect or substitution outside quotes. A heredoc body, a
 * second command and a redirect target never reach the summary.
 */
function firstSimpleCommand(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') i++;
    else if ('\n;|&<>`('.includes(c) || (c === '$' && line[i + 1] === '(')) return line.slice(0, i);
  }
  return line;
}

/** Shell words, quotes removed (no expansion). */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const safe = (w: string | undefined): w is string =>
  w !== undefined && SAFE_WORD.test(w) && !looksLikeSecretValue(w);

/**
 * A command as `<program> [<first argument>]`, the only parts a working-on line
 * shows of it: a shell's `-c` script is unwrapped to its first simple command,
 * leading assignments and `sudo`-style prefixes are skipped, and an argument
 * that is quoted text, an assignment or secret-shaped is left out. Empty when
 * the program itself is not a plain word.
 */
export function commandSummary(cmd: string | readonly string[], depth = 0): string {
  let argv = typeof cmd === 'string' ? shellWords(firstSimpleCommand(cmd)) : [...cmd];
  const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1);
  while (argv.length > 0 && (ASSIGNMENT.test(argv[0]!) || PREFIXES.has(base(argv[0]!)))) {
    argv = argv.slice(1);
  }
  const prog = argv[0] !== undefined ? base(argv[0]) : undefined;
  if (!safe(prog)) return '';
  if (SHELLS.has(prog) && depth < 2) {
    const c = argv.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    const script = c > 0 ? argv[c + 1] : undefined;
    if (script !== undefined) return commandSummary(script, depth + 1) || prog;
  }
  const arg = argv[1];
  return safe(arg) ? `${prog} ${arg}` : prog;
}

/** A URL without its query and fragment, which is where tokens ride. */
function bareUrl(v: string): string {
  const cut = v.search(/[?#]/);
  return cut === -1 ? v : v.slice(0, cut);
}

/** `<tool>: <detail>` for one tool call, or the bare tool name. */
export function toolActivity(name: string, input: unknown): string {
  const o = asObject(input);
  let detail: string | undefined;
  for (const k of DETAIL_KEYS) {
    const v = o?.[k];
    if (k === 'command' || k === 'cmd') {
      const argv = Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
      const text = nonEmptyString(v);
      detail = argv || text ? nonEmptyString(commandSummary(argv ?? text!)) : undefined;
    } else if (k === 'url') {
      detail = nonEmptyString(v) ? bareUrl(v as string) : undefined;
    } else {
      detail = nonEmptyString(v);
    }
    if (detail) break;
  }
  return activityLine(detail ? `${name}: ${detail}` : name);
}
