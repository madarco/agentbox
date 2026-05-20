import { getBoxHostPaths, refreshExport } from '@agentbox/sandbox-docker';
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { handleLifecycleError } from './_errors.js';

export interface PathOpts {
  refresh?: boolean;
  includeNodeModules?: boolean;
}

// The `path` command was folded into `agentbox open --path`; this is the
// extracted body, called by open.ts with an already-resolved box.
export async function runPath(box: BoxRecord, opts: PathOpts): Promise<void> {
  try {
    const { record, paths } = await getBoxHostPaths(box.id);

    if (opts.refresh) {
      const refreshed = await refreshExport(record, {
        includeNodeModules: opts.includeNodeModules,
      });
      process.stdout.write(`${refreshed.hostPath}\n`);
      return;
    }

    process.stdout.write(`${paths.mergedExport}\n`);
  } catch (err) {
    handleLifecycleError(err);
  }
}
