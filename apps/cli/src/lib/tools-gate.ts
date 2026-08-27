import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm, isCancel, log } from '@clack/prompts';
import { loadGrantedTools, resolveProjectToolsFile, writeToolGrant } from '@agentbox/config';
import { parseToolsSection, type ToolRequest } from '@agentbox/ctl';

/**
 * Host-side gate for `agentbox.yaml`'s `tools:` block.
 *
 * The block is a *request*, not a grant. `agentbox.yaml` is committed, so a
 * repo you cloned must not be able to hand its own box your host's `aws`
 * credentials just by declaring it. The host approves once per project, the
 * approval lands in the host-only grant file, and the relay reads only that.
 *
 * Same shape as the `carry:` gate (see carry-gate.ts): read the yaml, work
 * out what is new, prompt once for the whole set, proceed either way. A
 * declined request leaves the tool ungranted and the box simply doesn't get
 * the command — creation is not blocked, because an unmet tool request is a
 * missing convenience, not a broken box.
 */

export interface ToolsGateArgs {
  /** Absolute project root (dir holding agentbox.yaml). */
  projectRoot: string;
  /** `-y` / `--yes`: approve the project's declared tools without asking. */
  yes: boolean;
  /** Caller-controlled TTY check; default `process.stdin.isTTY`. */
  isTTY?: boolean;
  onLog?: (line: string) => void;
}

export interface ToolsGateResult {
  /** Tool names newly written to the project grant file. */
  granted: string[];
  /** Requested but declined (or skipped) — left ungranted. */
  declined: string[];
}

export async function runToolsGate(args: ToolsGateArgs): Promise<ToolsGateResult> {
  const emit = args.onLog ?? (() => {});
  const empty: ToolsGateResult = { granted: [], declined: [] };

  let yamlText = '';
  try {
    yamlText = await readFile(join(args.projectRoot, 'agentbox.yaml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return empty;
  }

  let requests: ToolRequest[];
  try {
    requests = parseToolsSection(yamlText);
  } catch (err) {
    // A malformed block is a project bug worth surfacing, but it must not
    // stop the box from being created.
    log.warn(`tools: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
  if (requests.length === 0) return empty;

  const existing = await loadGrantedTools(args.projectRoot);
  const pending = requests.filter((r) => !existing.has(r.name));
  if (pending.length === 0) {
    emit(`tools: ${String(requests.length)} requested, all already granted`);
    return empty;
  }

  const names = pending.map((r) => r.name).join(', ');
  const declined = (): ToolsGateResult => {
    emit(`tools: declined ${names}`);
    log.info(`tools: not granted (${names}). Grant later with \`agentbox tools add <name>\`.`);
    return { granted: [], declined: pending.map((r) => r.name) };
  };

  if (!args.yes) {
    // No TTY and no --yes: decline cleanly rather than throwing. Unlike
    // `carry:` (whose whole point is copying files the box needs), an
    // ungranted tool just means one missing command — failing the create
    // would be worse than proceeding without it. `@clack`'s confirm throws
    // `uv_tty_init` on a non-TTY stdin, so this has to be checked, not caught.
    if (!(args.isTTY ?? process.stdin.isTTY)) {
      log.info(
        `tools: ${names} requested but stdin is not a TTY — not granted. ` +
          'Re-run with --yes, or grant on the host with `agentbox tools add <name>`.',
      );
      return declined();
    }
    // Show what is ACTUALLY being granted, not just the names. The yaml is
    // untrusted: it can point a familiar-looking name at a different host
    // binary, and its `allow` patterns skip the per-call approval prompt. If
    // the user is going to consent, they have to be able to see both.
    printRequestSummary(pending);
    const answer = await confirm({
      message: `Grant this project access to ${String(pending.length)} host CLI(s)?`,
      initialValue: false,
    });
    if (isCancel(answer) || !answer) return declined();
  }

  const file = await resolveProjectToolsFile(args.projectRoot);
  const approvedAt = new Date().toISOString();
  for (const req of pending) {
    await writeToolGrant(file, {
      name: req.name,
      bin: req.bin ?? req.name,
      source: 'yaml',
      approvedAt,
      ...(req.allow ? { allow: req.allow } : {}),
      ...(req.deny ? { deny: req.deny } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    });
  }
  emit(`tools: granted ${names}`);
  // Always visible, including under --yes: granting a host CLI is a standing
  // capability for this box, so it should never happen silently.
  log.info(`tools: granted ${names} — this box can now run them on the host.`);
  return { granted: pending.map((r) => r.name), declined: [] };
}

/**
 * Render each pending request so the approval is informed: the command name
 * the box will type, the host binary it actually runs when those differ, and
 * any `allow` patterns (which bypass the per-call prompt) or `deny` patterns
 * (which only narrow, so they are reassurance rather than risk).
 */
function printRequestSummary(pending: readonly ToolRequest[]): void {
  const lines = pending.map((r) => {
    const parts = [`  ${r.name}`];
    if (r.bin && r.bin !== r.name) parts.push(`-> runs host \`${r.bin}\``);
    if (r.allow) parts.push(`[${String(r.allow.length)} allow rule(s): ${r.allow.join(', ')}]`);
    if (r.deny) parts.push(`[${String(r.deny.length)} deny rule(s)]`);
    return parts.join('  ');
  });
  log.message(
    [
      'This project requests access to host CLIs. They will run on the host,',
      "with the host's own credentials, in this project directory:",
      '',
      ...lines,
      '',
      'Allow rules run without a per-call approval prompt.',
    ].join('\n'),
  );
}
