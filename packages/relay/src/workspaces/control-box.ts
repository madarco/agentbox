/**
 * The control box THIS machine is configured to route to, if any.
 *
 * One resolver, because three processes need the same answer and must not
 * disagree: the hub (which mirrors the control box's providers), the timeline
 * sink (which forwards this machine's events to the hub that owns the boxes),
 * and the CLI's queue worker. It reads the same two places `agentbox hub setup`
 * writes — `relay.controlPlaneUrl` in the layered config and
 * `AGENTBOX_HUB_API_KEY` in `~/.agentbox/control-plane/control-plane.env` — and
 * never throws.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import { parseEnvFileBody } from '@agentbox/sandbox-core';

/** Where `agentbox hub setup` records the control box's `/api/v1` key. */
export function controlPlaneEnvPath(home: string = homedir()): string {
  return path.join(home, '.agentbox', 'control-plane', 'control-plane.env');
}

export interface ControlBoxTarget {
  url: string;
  apiKey: string;
}

export interface ResolveControlBoxOptions {
  /**
   * Also require `cloud.viaHub`. Only for the provider mirror: with it off, cloud
   * boxes are built HERE again, so the control box's bakes describe nobody's
   * work. The store (workspaces, tasks, timeline) is not conditional that way —
   * it lives wherever the control box is, however the boxes get built.
   */
  requireViaHub?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * True when this process IS a control box (deployed, or a hub this machine
 * exposed). Both run the resident worker, and only they do. A control box has no
 * control box of its own, so resolving one here would mean pointing at itself.
 */
export function isControlBoxProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTBOX_HUB_WORKER === 'on';
}

/** The configured control box + its API key, or null when there is none. */
export async function resolveControlBox(
  opts: ResolveControlBoxOptions = {},
): Promise<ControlBoxTarget | null> {
  const env = opts.env ?? process.env;
  if (isControlBoxProcess(env)) return null;
  const home = opts.home ?? homedir();
  try {
    const cfg = await loadEffectiveConfig(home);
    const url = (cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/+$/, '');
    if (!url) return null;
    if (opts.requireViaHub && !cfg.effective.cloud.viaHub) return null;
    // The key never reaches this process's env (the hub is spawned before, or
    // without, `hub setup`), so read the file the CLI writes it to.
    const fileEnv = parseEnvFileBody(
      await readFile(controlPlaneEnvPath(home), 'utf8').catch(() => ''),
    );
    const apiKey = env.AGENTBOX_HUB_API_KEY || (fileEnv.AGENTBOX_HUB_API_KEY ?? '');
    return apiKey ? { url, apiKey } : null;
  } catch {
    return null;
  }
}
