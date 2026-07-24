/**
 * Foreground cloud-agent routing through the control box.
 *
 * `agentbox claude|codex|opencode` on a cloud provider, with a control box
 * configured (and `cloud.viaHub` on), builds the box ON the control box instead
 * of on this machine — so it lives in the same place as `agentbox create` boxes.
 * The resident hub worker clones the repo VPS-side and provisions the box, then
 * this PC ADOPTS it (writes local state + downloads its SSH keys) so the normal
 * attach path can launch the agent and drop you into the session.
 *
 * The worker creates the box "cold": it never starts the agent (it drops any
 * prompt and keeps `agent` only as a registration hint). That is fine for the
 * FOREGROUND path — the caller attaches right after, and `cloudAgentAttach`
 * starts the agent on a cold box. It is why background `-i` does NOT route here:
 * a queued run needs the agent started detached with a seed prompt, which the
 * worker can't do yet, so `-i` stays on the local queue.
 */
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from './control-plane.js';
import { enqueueCreateViaHub, pollHubJob } from '../control-plane/hub-enqueue.js';
import { adoptHubBox } from '../control-plane/hub-adopt.js';
import { ControlPlaneAdminClient } from '../control-plane/admin-client.js';
import { CustodyClient } from '../control-plane/custody-client.js';

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
  /** Progress lines (enqueue + poll transitions). */
  onStatus?: (line: string) => void;
  /** Verbose adopt log. */
  onLog?: (line: string) => void;
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

  const jobId = await enqueueCreateViaHub(target, {
    repoUrl,
    provider: providerName,
    branch: fromBranch?.trim() || undefined,
    name: name?.trim() || undefined,
    agent,
  });
  onStatus?.(`enqueued on the control plane (job ${jobId})`);
  const job = await pollHubJob(target, jobId, {
    onStatus: (j) => onStatus?.(`job ${jobId}: ${j.status}`),
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
  const { providerName, projectRoot, agent, name, fromBranch, prompt, agentArgs, urlFlag, onStatus } =
    args;
  const target = await resolveCustodyTarget(urlFlag, { quiet: true });
  if (!target) return null;
  const repoUrl = await readGitOriginUrl(projectRoot).catch(() => undefined);
  if (!repoUrl) return null;

  const jobId = await enqueueCreateViaHub(target, {
    repoUrl,
    provider: providerName,
    branch: fromBranch?.trim() || undefined,
    name: name?.trim() || undefined,
    agent,
    prompt,
    agentArgs,
  });
  onStatus?.(`enqueued on the control plane (job ${jobId})`);
  const job = await pollHubJob(target, jobId, {
    onStatus: (j) => onStatus?.(`job ${jobId}: ${j.status}`),
  });
  // A failed job with a boxId means the box was created but the agent didn't
  // start (e.g. creds rejected) — surface the error but keep the box id.
  return { boxId: job.result?.boxId, error: job.status === 'done' ? undefined : job.result?.error };
}
