// The box state store is provider-neutral and lives in @agentbox/sandbox-core
// so cloud providers share it. The record TYPES live in @agentbox/core. Both
// are re-exported here so existing `@agentbox/sandbox-docker` consumers keep
// importing them from the same place.
export {
  STATE_DIR,
  STATE_FILE,
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  readState,
  recordBox,
  recordLastAgent,
  removeBoxRecord,
  reserveProjectIndex,
  resolveBoxRef,
  writeState,
} from '@agentbox/sandbox-core';
export type { BoxRecord, FindBoxResult, GitWorktreeRecord, StateFile } from '@agentbox/core';
