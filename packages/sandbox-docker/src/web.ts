/**
 * The single container port AgentBox reserves + publishes for a box's web
 * service. The `-p 127.0.0.1:0:80` mapping is created unconditionally at
 * `create` (immutable after `docker run`); the in-box supervisor forwards :80
 * to the `expose:`-flagged service's port once `agentbox.yaml` is set. Mirrors
 * `VNC_CONTAINER_PORT`. Must equal `RESERVED_WEB_PORT` in @agentbox/ctl.
 */
export const WEB_CONTAINER_PORT = 80;
