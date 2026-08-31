/**
 * The fourth agent.
 *
 * It exists to answer one question with a number instead of an opinion: what
 * does adding an agent to AgentBox actually cost? Every layer that still needs
 * hand-wiring fails loudly while this package is present, so the remaining cost
 * is a test result rather than a claim.
 *
 * `hidden: true` keeps it out of pickers, `--help` and the bake list — it is a
 * canary, not a supported agent. It is real everywhere else: the registry
 * resolves it, the machinery iterates it, and `agentbox example` builds a box
 * that works.
 *
 * Its "agent" is a login shell. That is deliberate: `bash` is in every base
 * image, so the package proves the whole seam — install probe, config volume,
 * tmux session, activity probe, attach — with no network, no npm package, and
 * nothing that can rot. Swap `binary`/`install` and it becomes a real agent
 * without touching anything else.
 *
 * Imports only the two dependency-free leaves; see `spec-purity.test.ts`.
 */

import { BOX_HOME, BOX_CREDS_DIR, BOX_USER } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';
import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';

const EXAMPLE_BOX_DIR = `${BOX_HOME}/.agentbox-example`;

export const exampleSpec: AgentSyncSpec = {
  id: 'example',
  aliases: [],
  hidden: true,
  sessionName: 'example',
  // Always present in the base image, so `command -v` succeeds and the install
  // recipe never runs. A real agent names its own CLI here.
  binary: 'bash',
  install: {
    // Never reached (the probe finds bash), but a spec must declare how it would
    // install, and `true` is the honest no-op.
    recipe: { kind: 'exec', script: 'true' },
    runAs: 'root',
    postInstall: [
      `install -d -o ${BOX_USER} -g ${BOX_USER} ${EXAMPLE_BOX_DIR} ${BOX_CREDS_DIR}/example`,
    ].join(' && '),
  },
  dockerVolume: 'agentbox-example-config',
  staticPaths: [
    {
      hostHomeRel: ['.agentbox-example'],
      boxDir: EXAMPLE_BOX_DIR,
    },
  ],
  credential: {
    boxRelPath: 'auth.json',
    boxAbsPath: `${EXAMPLE_BOX_DIR}/auth.json`,
    hostBackup: join(STATE_DIR, 'example-credentials.json'),
    cloudMountPath: `${BOX_CREDS_DIR}/example`,
    cloudSubpath: 'auth.json',
    realShape: 'nonempty-json',
  },
  forwardedEnvKeys: [],
  boxRunEnv: {},
  caps: {
    resume: false,
    teleport: 'stub',
    teleportStubReason:
      'The example agent is a seam canary with no conversation to teleport. Run `agentbox example` to start a fresh box.',
    // Reports nothing: no hooks, no plugin, and ctl ships no scraper for it. ctl
    // therefore skips probing it rather than reporting a permanent `unknown`.
    activitySource: [],
  },
  // Declared because `staticPaths` is: an agent that can be pushed into a box
  // must say how it comes back out, or `agentbox download example` silently
  // does nothing. Data, not code -- which is the point.
  pull: { items: [{ group: 'data', names: ['auth.json'] }] },
};
