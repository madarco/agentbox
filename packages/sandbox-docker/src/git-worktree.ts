// Host-side git-repo detection is provider-neutral (cloud boxes also seed from
// git) and lives in @agentbox/sandbox-core. Re-exported here so existing
// `@agentbox/sandbox-docker` consumers are unchanged.
export {
  detectGitRepos,
  GitWorktreeError,
  pickFreshBranch,
  type DetectedGitRepo,
} from '@agentbox/sandbox-core';
