/**
 * `makeProgressReporter(verbose)` — small adapter around the clack spinner
 * that lets long-running commands (`create`, `claude`, `codex`,
 * `opencode`) opt into a `-v / --verbose` mode that bypasses the spinner
 * entirely and streams raw output to stderr.
 *
 * Without `--verbose` the returned object proxies a clack `spinner()`:
 *   - `start(label)`  → `s.start(label)`
 *   - `message(line)` → `s.message(clampSpinnerLine(line))`
 *   - `stop(label)`   → `s.stop(label)`
 *
 * With `--verbose` the spinner is never created. `start` / `stop` write a
 * single status line to stderr; `message` writes the raw, unclamped line
 * (preserving any newlines from the provider). This is the right mode
 * for the ~7-min cold cloud create where users want to see real progress.
 *
 * Either way, callers should still write every line to `cmdLog` so the
 * full transcript lands in `~/.agentbox/logs/<command>.log`. This helper
 * only handles the user-visible surface.
 */
import { spinner } from '@clack/prompts';
import { clampSpinnerLine } from '../spinner-line.js';
import { logToActiveCommand } from './log-file.js';

export interface ProgressReporter {
  start(label: string): void;
  message(line: string): void;
  /** `code` is clack's stop code — non-zero renders the line as a failure. */
  stop(label: string, code?: number): void;
}

export function makeProgressReporter(verbose: boolean): ProgressReporter {
  if (!verbose) {
    const s = spinner();
    return {
      start: (label) => s.start(label),
      message: (line) => s.message(clampSpinnerLine(line)),
      stop: (label, code) => s.stop(label, code),
    };
  }
  return {
    start: (label) => process.stderr.write(`${label} (verbose)\n`),
    message: (line) => process.stderr.write(line.endsWith('\n') ? line : line + '\n'),
    stop: (label) => process.stderr.write(`${label}\n`),
  };
}

/**
 * An `onProgress` for `ensureImage` that shows the line on `s` AND records it in
 * the active command log.
 *
 * The image layer decides whether to pull a published base or rebuild it
 * locally (~10 minutes). That decision, and the reason a pull was skipped, used
 * to go only to the spinner — which overwrites itself, so nothing survived to be
 * read afterwards and a rate-limited pull looked exactly like an unpublished
 * tag. Every create-style command routes `ensureImage` through this.
 */
export function imageProgress(s: { message(line: string): void }): (line: string) => void {
  return (line) => {
    s.message(clampSpinnerLine(line));
    if (isImageDecisionLine(line)) logToActiveCommand(line);
  };
}

/**
 * True for `ensureImage`'s own decision lines, false for docker's per-layer
 * output (`<hex>: Pulling fs layer`, `Download complete`, `Extracting`, …).
 *
 * The `[image]` tag alone is not a usable discriminator: some callers prefix
 * *every* forwarded line with it, so matching on the tag would tee a hundred
 * layer lines into the log and bury the one line anyone needs. Match the
 * decision vocabulary instead.
 */
export function isImageDecisionLine(line: string): boolean {
  // Reject docker's per-layer output first — `<id>: Pulling fs layer` also
  // contains "pulling", so the allowlist alone would admit all of it.
  if (
    /:\s*(pulling fs layer|waiting|downloading|download complete|extracting|pull complete|already exists|verifying checksum)/i.test(
      line,
    )
  ) {
    return false;
  }
  return DECISION_PATTERNS.some((re) => re.test(line));
}

/** The vocabulary `ensureImage` / `pullOrBuild` use for the pull-vs-build call. */
const DECISION_PATTERNS: RegExp[] = [
  /\bpulling\b/i,
  /\bpulled\b/i,
  /\bpull failed\b/i,
  /\bbuilding\b/i,
  /\bnot present\b/i,
  /\bup to date\b/i,
  /\bbuild context changed\b/i,
  /no docker-prepared/i,
  /authenticat/i, // "retrying authenticated", "could not authenticate"
  /\bcould not\b/i,
];
