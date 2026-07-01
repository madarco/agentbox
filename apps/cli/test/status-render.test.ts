import { describe, expect, it } from 'vitest';
import type { BoxStatus, StatusReply } from '@agentbox/ctl';
import { renderLiveSections, renderPersistedSections } from '../src/commands/_status-render.js';

const persisted: BoxStatus = {
  schema: 1,
  boxId: 'b9615a54d',
  timestamp: '2026-06-22T13:36:34.446Z',
  services: [],
  tasks: [
    { name: 'install', state: 'done' },
    { name: 'build', state: 'running' },
  ],
  ports: [
    { port: 80, service: 'web' },
    { port: 5173, service: null },
  ],
  claude: { state: 'working', updatedAt: null },
} as unknown as BoxStatus;

describe('renderPersistedSections', () => {
  it('lists each task by name and state (not just a count)', () => {
    const text = renderPersistedSections(persisted).join('\n');
    expect(text).toContain('TASKS');
    expect(text).toContain('install  done');
    expect(text).toContain('build  running');
  });

  it('renders named ports and rolls anonymous ports into an "other" line', () => {
    const text = renderPersistedSections(persisted).join('\n');
    expect(text).toContain(':80  (web)');
    expect(text).toContain('other (1): 5173');
  });

  it('omits the TASKS heading when there are no tasks', () => {
    const noTasks = { ...persisted, tasks: [] } as unknown as BoxStatus;
    expect(renderPersistedSections(noTasks).join('\n')).not.toContain('TASKS');
  });
});

describe('renderLiveSections', () => {
  it('renders a TASKS table when tasks are present', () => {
    const live: StatusReply = {
      services: [],
      tasks: [
        {
          name: 'build',
          state: 'running',
          pid: 12,
          lastExitCode: null,
          startedAt: '2026-06-22T13:30:00Z',
          finishedAt: null,
          command: 'pnpm build',
        },
      ],
      ports: [{ port: 80, service: 'web' }],
    };
    const text = renderLiveSections(live).join('\n');
    expect(text).toContain('TASKS');
    expect(text).toContain('build');
    expect(text).toContain('SERVICES');
    expect(text).toContain('PORTS');
  });

  it('omits TASKS when no tasks are configured', () => {
    const live: StatusReply = { services: [], tasks: [], ports: [] };
    expect(renderLiveSections(live).join('\n')).not.toContain('TASKS');
  });
});
