import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The checkouts registry is only as complete as its writers. Every create entry
// point must report the folder it creates from: `agentbox create` and the agent
// commands (`agentbox claude`, the main entry point), which once never did.
describe('checkouts are reported from every create entry point', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it.each(['commands/create.ts', 'agents/command/create-action.ts'])('%s', (file) => {
    expect(src(file)).toMatch(/reportCheckoutInBackground\(projectRoot\)/);
  });

  it('workspace add and rescan report the scanned folders', () => {
    expect(
      src('commands/workspace.ts').match(/reportCheckouts\(\s*client,\s*scan\.projects/g),
    ).toHaveLength(2);
  });
});
