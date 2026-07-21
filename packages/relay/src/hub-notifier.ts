/**
 * A minimal in-process fan-out for the embedded hub UI. The hub's SSE route
 * (`/api/events`) subscribes; the relay calls `notify()` whenever the pending
 * approvals set changes (via `PendingPrompts.setOnChange`), so connected
 * browsers refresh without polling. No `EventEmitter` dependency — the surface
 * is just subscribe/notify.
 */
export class HubNotifier {
  private readonly listeners = new Set<() => void>();

  /** Register a listener; returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fire every listener. A throwing listener never blocks the others. */
  notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a dead listener must not break the fan-out */
      }
    }
  }
}
