import { notionConnector } from './connectors/notion.js';
import type { IntegrationConnector } from './types.js';

/**
 * All integration connectors known to AgentBox. The relay's dispatcher
 * walks this list to validate `integration.<service>.<op>` calls — anything
 * not present is denied. Mirrors `packages/core/src/provider.ts`'s
 * registry pattern for the provider abstraction.
 */
export const ALL_CONNECTORS: readonly IntegrationConnector[] = [notionConnector];

/** Lookup by `IntegrationConnector.service`. Returns `null` for unknown. */
export function getConnector(service: string): IntegrationConnector | null {
  for (const c of ALL_CONNECTORS) {
    if (c.service === service) return c;
  }
  return null;
}
