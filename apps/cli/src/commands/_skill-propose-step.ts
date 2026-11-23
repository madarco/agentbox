/**
 * The "propose to library" step of `agentbox download <agent>` (hub-skills
 * Phase 7). Runs after the agent's own pull, whatever it found, and never fails
 * the download: a hub that can't be reached is one note.
 */
import { homedir } from 'node:os';
import { loadEffectiveConfig } from '@agentbox/config';
import type { AgentId, BoxRecord, SyncTransport } from '@agentbox/core';
import { withHubClientQuiet } from '../control-plane/with-hub.js';
import { workspaceHub } from '../lib/workspace-ref.js';
import {
  boxSkillDirs,
  describeBoxSkillOutcomes,
  proposeBoxSkills,
  proposeHint,
} from '../lib/skills/box-propose.js';

export async function runSkillProposeStep(opts: {
  box: BoxRecord;
  agent: AgentId;
  transport: SyncTransport;
  /** commander's `--no-propose` gives false. */
  propose?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  if (opts.propose === false || opts.dryRun) return;
  if (boxSkillDirs(opts.agent).length === 0) return;
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const r = await withHubClientQuiet(workspaceHub(), (client) =>
    proposeBoxSkills({
      client,
      box: opts.box,
      agent: opts.agent,
      transport: opts.transport,
      home: homedir(),
      maxBytes: cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024,
    }),
  );
  if (!r.ok) {
    process.stdout.write(`note: ${proposeHint(r.error)}\n`);
    return;
  }
  for (const line of describeBoxSkillOutcomes(r.value)) process.stdout.write(`${line}\n`);
}

export const PROPOSE_FLAG_HELP =
  "don't propose skills written in the box to the hub's skills library";
