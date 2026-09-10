// Per-file isolated HOME, matching packages/config and packages/relay. Vitest
// runs this before the test file's static imports evaluate, so the HOME-derived
// constants in @agentbox/config (PROJECTS_DIR and friends) point inside the temp
// dir. Load-bearing here because `runCreateGates` reads host state — the
// effective config and a project's carry grant — so without it a developer's own
// ~/.agentbox could change what these tests assert, and a test that writes a
// grant would leave a stray project dir in their real home.
import { useTempHome } from '../../../scripts/test-home.js';

useTempHome('agentbox-hub-home-');
