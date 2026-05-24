/**
 * Extract the internal `expose.port` values from a workspace's
 * `agentbox.yaml`. The cloud provider mints a preview URL per port so
 * users can hit services directly (the WebProxy on port 8080 also
 * stays — this is a side channel for raw access).
 *
 * Intentionally minimal: we don't validate the rest of the schema. The
 * supervisor enforces correctness at run-time; here we just need the
 * numeric `services.*.expose.port` values. Errors (missing file, bad
 * YAML, unexpected shape) silently degrade to "no extra ports", which
 * matches the existing "URL is best-effort at create" semantics.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export async function readExposedServicePorts(workspacePath: string): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(join(workspacePath, 'agentbox.yaml'), 'utf8');
  } catch {
    return [];
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  if (!isPlainObject(doc)) return [];
  const services = doc['services'];
  if (!isPlainObject(services)) return [];
  const out = new Set<number>();
  for (const value of Object.values(services)) {
    if (!isPlainObject(value)) continue;
    const expose = value['expose'];
    if (!isPlainObject(expose)) continue;
    const port = expose['port'];
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536) {
      out.add(port);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
