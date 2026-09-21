import type { ScenarioDef } from '../lib/runner.js';
import { s1 } from './s1-install-bake.js';
import { s2 } from './s2-agent-pr.js';
import { s3 } from './s3-lifecycle.js';
import { s4 } from './s4-services.js';
import { s5 } from './s5-host-tools.js';
import { s6 } from './s6-openclaw.js';
import { s7 } from './s7-workspace.js';

/** In report order. S1 runs first on every target; the rest run in parallel after it. */
export const SCENARIOS: ScenarioDef[] = [s1, s2, s3, s4, s5, s6, s7];
