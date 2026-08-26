import type { EffectiveConfig } from '@agentbox/config';

/**
 * True when a remote control box (hub) is configured — i.e. `relay.controlPlaneUrl`
 * is set. The canonical predicate for "there is a remote hub to route to", so the
 * cloud-create routing, `ls -g`, and by-name auto-adopt all agree on the condition.
 *
 * Kept dependency-light (type-only import) so any control-plane module can use it
 * without an import cycle.
 */
export function remoteHubConfigured(effective: EffectiveConfig): boolean {
  return Boolean(effective.relay.controlPlaneUrl);
}

/** True for the two providers whose boxes run on a local docker engine. */
export function isDockerProvider(name: string): boolean {
  return name === 'docker' || name === 'remote-docker';
}

/**
 * True when docker / remote-docker are gated off on this machine — the single
 * predicate every "docker off under a remote hub" site agrees on (`create`
 * refusal, `prepare` refusal, `doctor` / `install` provider lists, the `ls`
 * inactive-marking). Driven by `hub.mode`:
 *   - `local`  → never gated (the escape hatch).
 *   - `thin`   → always gated (force thin, even with no configured control box).
 *   - `auto`   → gated iff a control box is configured. A docker box built on the
 *     laptop can't run with the laptop off, which is the whole point of a control
 *     box, so once one is configured the fleet routes through the hub instead.
 *
 * Mirrors {@link isDockerProvider}'s docker + remote-docker pairing, matching
 * `boxOwningHubIsLocal` in with-hub.ts (both are "runs on a local engine").
 */
export function dockerProvidersHidden(effective: EffectiveConfig): boolean {
  const mode = effective.hub.mode;
  if (mode === 'local') return false;
  if (mode === 'thin') return true;
  return remoteHubConfigured(effective);
}

/**
 * Why docker is hidden here — a control box (`hub.mode=auto` + `relay.controlPlaneUrl`)
 * or a forced thin machine (`hub.mode=thin`). Only meaningful when
 * {@link dockerProvidersHidden} is true; keyed on `remoteHubConfigured` because
 * that is the exact discriminator (auto hides only with a control box, so a hidden
 * gate with no control box must be thin mode).
 */
export function dockerHiddenReason(effective: EffectiveConfig): string {
  return remoteHubConfigured(effective) ? 'a control box is configured' : 'hub.mode is set to thin';
}

/**
 * The one-line message every site prints when it hides docker, naming the config
 * key that brings it back. `context` tunes the verb, the reason reflects WHY docker
 * is off (control box vs thin mode), and the re-enable hint is shared so it can't
 * drift across sites.
 */
export function dockerHiddenMessage(
  effective: EffectiveConfig,
  context: 'create' | 'prepare' | 'setup',
  remoteHost?: string,
): string {
  const reason = dockerHiddenReason(effective);
  const lead =
    context === 'create'
      ? `docker boxes are not built on this machine because ${reason} (a docker box can only run with your laptop on).`
      : context === 'prepare'
        ? `docker images are not baked on this machine because ${reason}.`
        : `docker is unavailable on this machine because ${reason}.`;
  // For a remote-docker engine the better answer is almost never "turn the gate
  // off" — it is "let the control box drive that engine", which makes the box
  // laptop-independent instead of merely allowed.
  const fix = remoteHost
    ? `Share the engine with the control box (\`agentbox remote-docker share ${remoteHost}\`) so it runs there, or set \`hub.mode=local\` to build from this machine anyway.`
    : 'Set `hub.mode=local` (`agentbox config set hub.mode local`) to use docker here anyway.';
  return `${lead} ${fix}`;
}

/**
 * True when the configured control box IS this machine (`agentbox hub expose`).
 *
 * The docker gate exists because a box built here dies with the laptop — which
 * is not true when the laptop is the always-on machine. Without this, exposing
 * your own hub (or pointing `set-url` at it) switched local docker off for no
 * reason at all. Reads only the deploy record, so it is offline and cheap.
 */
export async function controlBoxIsThisMachine(): Promise<boolean> {
  try {
    const [{ readFile }, { controlPlaneDeployPath }] = await Promise.all([
      import('node:fs/promises'),
      import('@agentbox/sandbox-core'),
    ]);
    const raw = await readFile(controlPlaneDeployPath(), 'utf8');
    return (JSON.parse(raw) as { provider?: string }).provider === 'local';
  } catch {
    return false;
  }
}

/**
 * The message to print when a docker-family create/bake must be refused here, or
 * null when it may proceed. The one place the exceptions live:
 *
 *   - a control box that is this machine — its engine IS this engine;
 *   - a `docker:<alias>` engine the control box can reach, which the caller then
 *     routes there (the box outlives the laptop, so the gate's premise is void).
 */
export async function dockerProviderRefusal(
  effective: EffectiveConfig,
  providerName: string,
  remoteHost: string | undefined,
  context: 'create' | 'prepare' | 'setup',
): Promise<string | null> {
  if (!isDockerProvider(providerName)) return null;
  if (!dockerProvidersHidden(effective)) return null;
  if (await controlBoxIsThisMachine()) return null;
  if (providerName === 'remote-docker') {
    const { hubCanRunEngine } = await import('./remote-docker-share.js');
    if (await hubCanRunEngine(providerName, remoteHost, effective)) return null;
  }
  return dockerHiddenMessage(effective, context, remoteHost);
}
