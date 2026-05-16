import type { BoxEndpoints } from '@agentbox/sandbox-docker';
import { hyperlink } from './hyperlink.js';

/**
 * Render the box's network surface as aligned `name  value` lines (no section
 * header — callers prepend their own). URLs are OSC-8 clickable where the
 * terminal supports it. Returns [] when there's nothing to show so callers can
 * skip the whole block.
 */
export function renderEndpointLines(
  endpoints: BoxEndpoints,
  stream: NodeJS.WriteStream,
): string[] {
  if (endpoints.endpoints.length === 0) return [];

  const entries: Array<{ name: string; value: string }> = [
    { name: 'domain', value: endpoints.domain },
  ];

  for (const ep of endpoints.endpoints) {
    if (ep.url) {
      entries.push({ name: ep.name, value: hyperlink(ep.url, ep.url, stream) });
    } else if (ep.kind === 'vnc') {
      entries.push({ name: ep.name, value: 'enabled (URL unavailable — daemon may not be up)' });
    } else if (ep.kind === 'web') {
      entries.push({
        name: 'web',
        value: 'reserved (set a service `expose:` in agentbox.yaml)',
      });
    } else {
      entries.push({
        name: ep.name,
        value: `port ${String(ep.containerPort)} (box-only — not reachable from host)`,
      });
    }
  }

  const nameWidth = Math.max(...entries.map((e) => e.name.length));
  return entries.map((e) => `  ${e.name.padEnd(nameWidth)}  ${e.value}`);
}
