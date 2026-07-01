import {
  renderPortsTable,
  renderStatusTable,
  renderTaskTable,
  type BoxStatus,
  type StatusReply,
} from '@agentbox/ctl';
import { execInBox } from '@agentbox/sandbox-docker';

export async function fetchLive(state: string, container: string): Promise<StatusReply | null> {
  // Only a running container is reachable via `docker exec` (macOS can see the
  // socket file but can't connect to it). Paused/stopped — or a failed exec —
  // falls back to the snapshot the relay persisted to disk.
  if (state !== 'running') return null;
  const proc = await execInBox(container, ['agentbox-ctl', 'status', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return null;
  try {
    return JSON.parse(proc.stdout) as StatusReply;
  } catch {
    return null;
  }
}

/** TASKS / SERVICES / PORTS blocks from a live `agentbox-ctl status` pull. */
export function renderLiveSections(live: StatusReply): string[] {
  const out: string[] = [];
  if (live.tasks.length > 0) {
    out.push('TASKS', renderTaskTable(live.tasks), '');
  }
  out.push('SERVICES', renderStatusTable(live.services), '');
  out.push('PORTS', renderPortsTable(live.ports));
  return out;
}

/** TASKS / SERVICES / PORTS blocks from a persisted box-status snapshot. */
export function renderPersistedSections(s: BoxStatus): string[] {
  const out: string[] = [];
  if (s.tasks.length > 0) {
    out.push('TASKS');
    out.push(...s.tasks.map((t) => `  ${t.name}  ${t.state}`));
    out.push('');
  }
  out.push('SERVICES');
  if (s.services.length === 0) {
    out.push('  (none)');
  } else {
    out.push(
      ...s.services.map(
        (svc) => `  ${svc.name}  ${svc.state}${svc.port !== null ? `  :${String(svc.port)}` : ''}`,
      ),
    );
  }
  out.push('');
  out.push('PORTS');
  if (s.ports.length === 0) {
    out.push('  (none listening)');
  } else {
    const other = s.ports
      .filter((p) => !p.service)
      .map((p) => p.port)
      .sort((a, b) => a - b);
    out.push(
      ...s.ports
        .filter((p) => p.service)
        .map((p) => `  :${String(p.port)}  (${p.service})`),
    );
    if (other.length > 0) out.push(`  other (${other.length}): ${other.join(', ')}`);
  }
  return out;
}
