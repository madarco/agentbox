import type { EffectiveConfig } from '@agentbox/config';

/**
 * Per-provider sizing / session-lifetime overrides threaded through
 * `CreateBoxRequest.providerOptions`. The cloud scaffold
 * (`packages/sandbox-cloud/src/cloud-provider.ts`) reads these; providers that
 * don't recognise a key ignore it.
 *
 * - **vercel**: `vcpus` (RAM is coupled at 2 GB/vCPU), `timeoutMs` (session
 *   length before auto-snapshot), `networkPolicy`.
 * - **e2b**: `timeoutMs` — the session timeout the box is created with (and
 *   records as `cloud.sessionTimeoutMs`, which seeds the host keepalive loop so
 *   it can push the deadline forward while the agent is working).
 *
 * Shared by `agentbox create` and the agent-create commands (`claude` / `codex`
 * / `opencode`) so a box gets the same lifetime regardless of how it was made.
 */
export function cloudSizingProviderOptions(
  providerName: string,
  cfg: EffectiveConfig,
): Record<string, unknown> {
  if (providerName === 'vercel') {
    return {
      vcpus: cfg.box.vercelVcpus,
      timeoutMs: cfg.box.vercelTimeoutMs,
      networkPolicy: cfg.box.vercelNetworkPolicy,
    };
  }
  if (providerName === 'e2b') {
    return { timeoutMs: cfg.box.e2bTimeoutMs };
  }
  if (providerName === 'tenki') {
    // Session lifetime the box is created with (maps to Tenki's maxDurationMs)
    // and records as `cloud.sessionTimeoutMs` so the host keepalive loop can
    // push the deadline forward (via `session.extend`) while the agent works.
    return { timeoutMs: cfg.box.tenkiTimeoutMs };
  }
  return {};
}
