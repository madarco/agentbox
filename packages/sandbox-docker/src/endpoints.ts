import { join } from 'node:path';
import { loadConfig } from '@agentbox/ctl';
import type { BoxStatus } from '@agentbox/ctl';
import type { BoxEndpoint, BoxEndpoints, BoxRecord } from '@agentbox/core';
import type { DockerEngine } from './sync/host-export.js';
import { buildVncUrls, VNC_CONTAINER_PORT } from './vnc.js';
import { WEB_CONTAINER_PORT } from './web.js';

// BoxEndpoint / BoxEndpoints are the provider-neutral network-surface shape;
// they live in @agentbox/core. Re-exported so existing consumers are unchanged.
export type { BoxEndpoint, BoxEndpoints };

/**
 * Build the box's user-facing network surface. Pure host-side: no docker exec,
 * no network — safe to call from `agentbox list` in a tight loop.
 *
 * Service ports come from the persisted status snapshot when available
 * (`~/.agentbox/boxes/<id>/status.json`, pushed by the in-box supervisor via
 * the relay). That snapshot resolves `ready_when.port` *inside the box*, so it
 * works even when `agentbox.yaml` lives only in the box and was never pulled to
 * the host. Falls back to parsing the host's `agentbox.yaml` for pre-relay
 * boxes (or ones that never pushed a snapshot).
 *
 * Missing config + no snapshot is non-fatal: the VNC entry (if any) is still
 * returned. Engine drives reachability — OrbStack auto-routes
 * `<container>.orb.local:<port>` for any in-box port; other engines see only
 * what we explicitly publish via `docker run -p`, which today is just VNC.
 */
export async function getBoxEndpoints(
  record: BoxRecord,
  engine: DockerEngine,
  persisted?: BoxStatus | null,
): Promise<BoxEndpoints> {
  const domainIsOrb = engine === 'orbstack';
  const domain = domainIsOrb ? `${record.container}.orb.local` : '127.0.0.1';

  const endpoints: BoxEndpoint[] = [];

  if (record.vncEnabled && record.vncPassword) {
    const vncUrls = buildVncUrls(record, engine);
    // Preference: portless (stable name) > orb.local > loopback. Mirrors the
    // web endpoint's choice below and `agentbox screen`'s default.
    const url =
      engine === 'orbstack'
        ? (vncUrls.orbUrl ?? vncUrls.loopbackUrl)
        : (vncUrls.portlessUrl ?? vncUrls.loopbackUrl);
    endpoints.push({
      kind: 'vnc',
      name: 'vnc',
      containerPort: VNC_CONTAINER_PORT,
      url,
      reachable: Boolean(url),
    });
  }

  // The single `expose:`-flagged service, from the snapshot first (works when
  // agentbox.yaml lives only in the box), else the host yaml.
  let webServiceName: string | null = null;
  const persistedWeb = persisted?.services.find((s) => s.expose);
  if (persistedWeb) {
    webServiceName = persistedWeb.name;
  }

  const pushService = (name: string, port: number): void => {
    // The web service is surfaced as the dedicated `web` endpoint below;
    // don't also list it as a generic service.
    if (name === webServiceName) return;
    endpoints.push({
      kind: 'service',
      name,
      containerPort: port,
      // Only OrbStack auto-routes arbitrary in-box ports; on other engines we
      // don't publish service ports, so the URL isn't host-reachable.
      ...(domainIsOrb
        ? { url: `http://${domain}:${String(port)}`, reachable: true }
        : { reachable: false }),
    });
  };

  const persistedServices = persisted?.services.filter(
    (s): s is typeof s & { port: number } => typeof s.port === 'number',
  );
  if (persistedServices && persistedServices.length > 0) {
    for (const svc of persistedServices) pushService(svc.name, svc.port);
  } else {
    try {
      const cfg = await loadConfig(join(record.workspacePath, 'agentbox.yaml'));
      if (!webServiceName) {
        webServiceName = cfg.services.find((s) => s.expose)?.name ?? null;
      }
      for (const svc of cfg.services) {
        if (svc.readyWhen?.kind !== 'port') continue;
        pushService(svc.name, svc.readyWhen.port);
      }
    } catch {
      // No persisted snapshot and no host agentbox.yaml — skip service
      // endpoints. The VNC entry, if any, is unaffected.
    }
  }

  // Web endpoint: only for boxes that reserved container :80 at create. The
  // URL is the published loopback host port — uniform across engines, NOT
  // gated on OrbStack (requirement: don't rely on orb auto-DNS). No url until
  // both a service declares `expose:` and the host port is resolved; until
  // then it renders as "reserved".
  if (record.webContainerPort !== undefined) {
    const hasTarget = webServiceName !== null && record.webHostPort !== undefined;
    // A registered Portless alias gives the box a stable <name>.localhost URL
    // on non-OrbStack engines. `portlessUrl` is the real URL resolved from the
    // proxy at create/start (scheme + port vary); fall back to the https form
    // for records written before that field existed. No `portless` shell-out
    // here — this runs in a tight loop for `agentbox list`.
    const usePortless = record.portlessAlias !== undefined && engine !== 'orbstack';
    const webUrl = usePortless
      ? (record.portlessUrl ?? `https://${record.portlessAlias}.localhost`)
      : `http://127.0.0.1:${String(record.webHostPort)}`;
    endpoints.push({
      kind: 'web',
      name: webServiceName ?? 'web',
      containerPort: record.webContainerPort ?? WEB_CONTAINER_PORT,
      ...(hasTarget ? { url: webUrl, reachable: true } : { reachable: false }),
    });
  }

  return { domain, domainIsOrb, endpoints };
}
