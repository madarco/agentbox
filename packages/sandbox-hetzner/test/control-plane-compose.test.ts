import { describe, expect, it } from 'vitest';
import { hubContainerPort, isFullHubCompose } from '../src/control-plane-deploy.js';

/**
 * Regression net for the version skew that made a deploy 502 forever against a
 * healthy hub: the host generated `reverse_proxy app:8787` while the ref it
 * deployed (`main`, v0.27.1) published `8787:3000` and listened on :3000. Both
 * halves of the fix are covered — derive the upstream port from the ref that is
 * actually being deployed, and refuse a ref whose compose predates the full hub.
 */

// v0.27.1 — the Next-only hub behind Postgres.
const LEGACY_COMPOSE = `services:
  db:
    image: postgres:16
  app:
    environment:
      AGENTBOX_HUB_PROFILE: \${AGENTBOX_HUB_PROFILE:-vercel}
    ports:
      - '8787:3000'
`;

// The full hub (SQLite, resident worker) — listens on 8787 in-container.
const FULL_COMPOSE = `services:
  app:
    environment:
      AGENTBOX_HUB_PORT: '8787'
    volumes:
      - \${AGENTBOX_HUB_DATA_DIR:-./hub-data}:/root/.agentbox
    ports:
      - '8787:8787'
`;

describe('hubContainerPort', () => {
  it('reads the container side of the published 8787 mapping', () => {
    expect(hubContainerPort(LEGACY_COMPOSE)).toBe(3000);
    expect(hubContainerPort(FULL_COMPOSE)).toBe(8787);
  });

  it('accepts unquoted, double-quoted, and IP-prefixed mappings', () => {
    expect(hubContainerPort('    ports:\n      - 8787:3000\n')).toBe(3000);
    expect(hubContainerPort('    ports:\n      - "8787:3000"\n')).toBe(3000);
    expect(hubContainerPort("    ports:\n      - '127.0.0.1:8787:3000'\n")).toBe(3000);
  });

  it('returns undefined when there is no 8787 mapping to read', () => {
    // Callers fall back to this CLI's own port rather than guessing.
    expect(hubContainerPort('services:\n  app:\n    ports:\n      - \'9000:3000\'\n')).toBeUndefined();
    expect(hubContainerPort('')).toBeUndefined();
  });
});

describe('isFullHubCompose', () => {
  it('rejects a ref that predates the full-hub deploy', () => {
    expect(isFullHubCompose(LEGACY_COMPOSE)).toBe(false);
  });

  it('accepts a compose that consumes the deploy-provided data dir', () => {
    expect(isFullHubCompose(FULL_COMPOSE)).toBe(true);
  });
});
