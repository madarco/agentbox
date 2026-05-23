export {
  STATE_DIR,
  STATE_FILE,
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  readState,
  recordBox,
  removeBoxRecord,
  resolveBoxRef,
  writeState,
} from './state.js';
export {
  detectGitRepos,
  GitWorktreeError,
  pickFreshBranch,
  type DetectedGitRepo,
} from './git-detect.js';
