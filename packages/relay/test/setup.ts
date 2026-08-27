// Per-file isolated HOME. The relay's queue module captures
// `QUEUE_DIR = join(STATE_DIR, 'queue')` at module-eval time from
// `os.homedir()`, so without this a suite exercising the queue writes jobs
// into the developer's REAL `~/.agentbox/queue`.
//
// That is not hypothetical: `queue.test.ts` cleaned up by unlinking the files
// it wrote, but the queue loop under test rewrites a job when it reaps a dead
// worker — racing that cleanup and leaving a stray `qvitest-*.json` behind,
// which then shows up in `agentbox list` as a phantom box in state `error`.
//
// Relocating HOME removes the whole class rather than the one race.
import { useTempHome } from '../../../scripts/test-home.js';

useTempHome('agentbox-relay-home-');
