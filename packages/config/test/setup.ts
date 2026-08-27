// Per-file isolated HOME — vitest runs this setup file before the test file's
// static imports evaluate, so the HOME-derived constants in @agentbox/config
// (GLOBAL_CONFIG_FILE, PROJECTS_DIR) point inside this temp dir. These suites
// delete `$HOME/.agentbox` between tests, so this relocation is load-bearing,
// not a tidiness measure.
import { useTempHome } from '../../../scripts/test-home.js';

useTempHome('agentbox-cfg-home-');
