/**
 * Wait for a Daytona snapshot to reach `active`.
 *
 * `_experimental_createSnapshot` returns once the capture is *requested*; the
 * snapshot only becomes usable a little later. Acting on it before then — a
 * `create({ snapshot })`, or deleting the source sandbox — is racy, so every
 * capture path waits here first.
 *
 * Its own module because both the VM bake and the checkpoint path need it, and
 * the bake imports the backend (which owns the checkpoint), so a shared home
 * avoids an import cycle.
 */
import type { Daytona } from '@daytona/sdk';

export async function waitForSnapshotActive(
  client: Daytona,
  name: string,
  timeoutMs = 900_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state: string | undefined;
    try {
      state = (await client.snapshot.get(name))?.state;
    } catch {
      // A just-requested snapshot can 404 briefly before it's registered.
      state = undefined;
    }
    if (state === 'active') return;
    if (state === 'error' || state === 'build_failed') {
      throw new Error(`daytona snapshot '${name}' ended in state '${state}'`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `daytona snapshot '${name}' did not become active within ${String(Math.round(timeoutMs / 60_000))} min ` +
          `(state: ${state ?? 'unknown'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
