/**
 * Cloud-agent routing through the control box.
 *
 * `agentbox claude|codex|opencode` on a cloud provider, with a control box
 * configured (and `cloud.viaHub` on), builds the box ON the control box instead
 * of on this machine — so it lives in the same place as `agentbox create` boxes.
 * The resident hub worker clones the repo VPS-side and provisions the box.
 *
 * Two shapes:
 *   - **Foreground** (`createCloudBoxViaHubAndAdopt`): the worker creates the box
 *     "cold" (no agent), then this PC ADOPTS it (local state + SSH keys) so the
 *     normal attach path launches the agent and drops you into the session.
 *   - **Background `-i`** (`enqueueAgentJobViaHub`): the worker creates the box AND
 *     starts the agent detached with the seed prompt (it seeds the agent login
 *     from custody first), so the whole run lives on the VPS — laptop off from
 *     submit on. No adopt/attach here; it's fire-and-forget.
 */
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget, syncAgentCredentialsIfChanged } from './control-plane.js';
import { enqueueCreateViaHub, pollHubJob } from '../control-plane/hub-enqueue.js';
import { adoptHubBox } from '../control-plane/hub-adopt.js';
import { ControlPlaneAdminClient } from '../control-plane/admin-client.js';
import { CustodyClient } from '../control-plane/custody-client.js';
import { makeProgressReporter } from '../lib/progress.js';

/**
 * Run a hub create under ONE self-updating status line.
 *
 * The job goes enqueued → queued → running, which used to print a line per
 * transition, each repeating the same job uuid — three lines of noise for one
 * thing changing state. A spinner rewrites the single line instead, and the id
 * (which the user can't act on) is gone. The worker's own progress lines land on
 * the same line, so the wait reads like a local create rather than a static
 * `running` for the minutes a cloud create takes.
 *
 * `verbose` swaps the spinner for the streamed-lines reporter the local create
 * path uses under `-v` — a clamped single line hides most of a remote log.
 *
 * Owns the try/catch so the line is always closed: an un-stopped clack spinner
 * leaves the terminal spinning after the command has already failed.
 */
export async function withHubJobLine<T>(
  work: (onStatus: (line: string) => void) => Promise<T>,
  finish: (result: T) => string,
  opts: { verbose?: boolean } = {},
): Promise<T> {
  const s = makeProgressReporter(opts.verbose === true);
  let started = false;
  const onStatus = (line: string): void => {
    if (started) {
      s.message(line);
      return;
    }
    started = true;
    s.start(line);
  };
  try {
    const result = await work(onStatus);
    if (started) s.stop(finish(result));
    return result;
  } catch (err) {
    if (started) s.stop('the remote hub create failed', 1);
    throw err;
  }
}

export interface CloudAgentViaHubArgs {
  /** Bare provider name (post `parseProviderSpec`). */
  providerName: string;
  /** Absolute project root — its `origin` is what the hub worker clones. */
  projectRoot: string;
  /** Agent this box is for; rides the registration so an adopt relaunches it. */
  agent: 'claude' | 'codex' | 'opencode';
  /** Friendly box name (`--name`), or undefined to let the worker pick one. */
  name?: string;
  /** `--from-branch` base ref for the box's per-box branch. */
  fromBranch?: string;
  /** `--url` control-box override (else `relay.controlPlaneUrl`). */
  urlFlag?: string;
  /** Progress lines (enqueue + poll transitions + the hub worker's own log). */
  onStatus?: (line: string) => void;
  /** Full transcript: the hub worker's log lines, then the adopt log. */
  onLog?: (line: string) => void;
}

/**
 * The hub's job log is timestamped per line (`<iso> <text>`) because it is also
 * read as a file after the fact. On a live status line the timestamp is just
 * width — the full line still goes to the command log.
 */
function withoutTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '');
}

/**
 * Wire the worker's log into both sinks: the live status line (timestamp
 * stripped) and the command-log transcript (verbatim).
 */
export function hubLogSink(
  onStatus: ((line: string) => void) | undefined,
  onLog: ((line: string) => void) | undefined,
): ((line: string) => void) | undefined {
  if (!onStatus && !onLog) return undefined;
  return (line) => {
    onStatus?.(withoutTimestamp(line));
    onLog?.(line);
  };
}

/**
 * Create the box on the control box, then adopt it locally. Returns the adopted
 * `BoxRecord` ready to attach, or `null` when the control box isn't fully
 * configured for it (no admin token / no git `origin`) so the caller can fall
 * back to a local build. Throws when the enqueued create job fails.
 */
export async function createCloudBoxViaHubAndAdopt(
  args: CloudAgentViaHubArgs,
): Promise<BoxRecord | null> {
  const { providerName, projectRoot, agent, name, fromBranch, urlFlag, onStatus, onLog } = args;
  const target = await resolveCustodyTarget(urlFlag, { quiet: true });
  if (!target) return null;
  const repoUrl = await readGitOriginUrl(projectRoot).catch(() => undefined);
  if (!repoUrl) return null;
  // Refresh custody's agent credentials FIRST. The worker seeds the box from
  // custody, and this machine holds the freshest token — without this the box
  // comes up logged out with whatever a previous `create --via-hub` last pushed
  // (a Claude refresh rotates the token, so a stale copy is dead, not merely
  // expired). `create.ts` has always done this; the agent commands did not.
  await syncAgentCredentialsIfChanged(urlFlag);

  const jobId = await enqueueCreateViaHub(target, {
    repoUrl,
    provider: providerName,
    branch: fromBranch?.trim() || undefined,
    name: name?.trim() || undefined,
    agent,
  });
  onStatus?.('enqueued on the remote hub');
  const job = await pollHubJob(target, jobId, {
    onStatus: (j) => onStatus?.(`remote hub: ${j.status}`),
    onLog: hubLogSink(onStatus, onLog),
  });
  if (job.status !== 'done') {
    throw new Error(`create job failed: ${job.result?.error ?? 'unknown error'}`);
  }
  const boxId = job.result?.boxId;
  if (!boxId) throw new Error('the control box created the box but returned no id to adopt');

  const res = await adoptHubBox({
    admin: new ControlPlaneAdminClient(target),
    custody: new CustodyClient(target),
    ref: boxId,
    controlPlaneUrl: target.url,
    log: onLog ?? ((): void => {}),
  });
  return res.record;
}

export interface AgentJobViaHubArgs extends CloudAgentViaHubArgs {
  /** The seed prompt — its presence tells the worker to START the agent in-box. */
  prompt: string;
  /** Fully-processed agent args (post-`--`, incl. skip-permissions). */
  agentArgs?: string[];
}

export interface AgentJobViaHubResult {
  /** The created box id, when the box was provisioned (even if the agent then failed). */
  boxId?: string;
  /** Set when the job failed — a create failure, or the agent failing to start. */
  error?: string;
}

/**
 * Enqueue a background `-i` run on the control box: the resident worker creates
 * the box AND starts the agent detached with the seed prompt, so the whole run
 * lives on the VPS (laptop off). Polls to a terminal state and returns the box
 * id + any error — no adopt/attach (it runs on the hub). Returns `null` when the
 * control box isn't fully configured (no admin token / no git origin), so the
 * caller can fall back to the local queue.
 */
export async function enqueueAgentJobViaHub(
  args: AgentJobViaHubArgs,
): Promise<AgentJobViaHubResult | null> {
  const {
    providerName,
    projectRoot,
    agent,
    name,
    fromBranch,
    prompt,
    agentArgs,
    urlFlag,
    onStatus,
    onLog,
  } = args;
  const target = await resolveCustodyTarget(urlFlag, { quiet: true });
  if (!target) return null;
  const repoUrl = await readGitOriginUrl(projectRoot).catch(() => undefined);
  if (!repoUrl) return null;
  // Refresh custody's agent credentials FIRST. The worker seeds the box from
  // custody, and this machine holds the freshest token — without this the box
  // comes up logged out with whatever a previous `create --via-hub` last pushed
  // (a Claude refresh rotates the token, so a stale copy is dead, not merely
  // expired). `create.ts` has always done this; the agent commands did not.
  await syncAgentCredentialsIfChanged(urlFlag);

  const jobId = await enqueueCreateViaHub(target, {
    repoUrl,
    provider: providerName,
    branch: fromBranch?.trim() || undefined,
    name: name?.trim() || undefined,
    agent,
    prompt,
    agentArgs,
  });
  onStatus?.('enqueued on the remote hub');
  const job = await pollHubJob(target, jobId, {
    onStatus: (j) => onStatus?.(`remote hub: ${j.status}`),
    onLog: hubLogSink(onStatus, onLog),
  });
  // A failed job with a boxId means the box was created but the agent didn't
  // start (e.g. creds rejected) — surface the error but keep the box id.
  return { boxId: job.result?.boxId, error: job.status === 'done' ? undefined : job.result?.error };
}
