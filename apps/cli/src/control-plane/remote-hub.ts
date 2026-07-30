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
): string {
  const reason = dockerHiddenReason(effective);
  const lead =
    context === 'create'
      ? `docker boxes are not built on this machine because ${reason} (a docker box can only run with your laptop on).`
      : context === 'prepare'
        ? `docker images are not baked on this machine because ${reason}.`
        : `docker is unavailable on this machine because ${reason}.`;
  return `${lead} Set \`hub.mode=local\` (\`agentbox config set hub.mode local\`) to use docker here anyway.`;
}
