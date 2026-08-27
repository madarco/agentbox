import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm, isCancel, log } from '@clack/prompts';
import { loadGrantedTools, projectToolsFile, writeToolGrant } from '@agentbox/config';
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
    const answer = await confirm({
      message: `This project requests access to host CLIs: ${names}. Grant them?`,
      initialValue: false,
    });
    if (isCancel(answer) || !answer) return declined();
  }

  const file = projectToolsFile(args.projectRoot);
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
