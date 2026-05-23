/**
 * The user-facing network surface of a box. Provider-neutral data shape: the
 * Docker provider builds it from `docker port` / OrbStack DNS / Portless, a
 * cloud provider from its preview URLs. Consumed by `agentbox list` / `inspect`
 * / `url`.
 */

export interface BoxEndpoint {
  kind: 'vnc' | 'service' | 'web';
  /** Service name (kind === 'service'/'web') or 'vnc' (kind === 'vnc'). */
  name: string;
  /** In-container port (6080 for VNC, the `ready_when.port` value for services). */
  containerPort: number;
  /** Host-side URL the user can open. Undefined when the port isn't host-reachable. */
  url?: string;
  /** Whether the URL is reachable from the host on the current engine/provider. */
  reachable: boolean;
}

export interface BoxEndpoints {
  /** Bare hostname/IP for the box (`<container>.orb.local`, `127.0.0.1`, or a cloud host). */
  domain: string;
  /** True when domain auto-routes any in-container port (OrbStack DNS). */
  domainIsOrb: boolean;
  /** Ordered list: VNC first (if enabled), then services in agentbox.yaml order. */
  endpoints: BoxEndpoint[];
}
