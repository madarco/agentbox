#!/usr/bin/env node
// The `agentbox` bin. Checks the Node version before loading anything else:
// the bundle's static import graph is resolved before any of its code runs, so
// the check can't live in the bundle itself. Same old-syntax rule as
// node-check.js.
import { nodeVersionProblem } from './node-check.js';

var problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(problem);
  process.exit(1);
}

// The launcher's one-hop guard (see src/lib/launcher.ts) is for the launcher
// alone; an agentbox that later spawns `agentbox` must not inherit it.
delete process.env.AGENTBOX_LAUNCHER_HOP;

// Present the bundle as the entry point: code that re-spawns the CLI or finds
// siblings via dirname(process.argv[1]) (pty-host.js, workers) expects dist/.
var entry = new URL('../dist/index.js', import.meta.url);
process.argv[1] = decodeURIComponent(entry.pathname);
import(entry.href);
