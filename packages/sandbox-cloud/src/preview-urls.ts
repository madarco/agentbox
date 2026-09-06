/**
 * Rebuilding a cloud box's port -> preview-URL map on start.
 *
 * Cached entries are kept because a preview URL we could not re-resolve this
 * start is still better than none. The one thing that must NOT survive is the
 * port the box has moved off: `inspect` reports every non-web entry as a
 * reachable `service-<port>` endpoint, so a stale web port would be published
 * as a second URL pointing at the port we just abandoned.
 */
export function mergePreviewUrls(args: {
  /** The map on the record, from a previous start. */
  cached: Record<number, string> | undefined;
  /** Per-service URLs re-minted this start. */
  fresh: Record<number, string>;
  /** The web port recorded before this start, if any. */
  previousWebPort: number | undefined;
  /** The web port this start resolved. */
  webPort: number;
  /** Freshly minted web preview URL, or undefined when it could not be resolved. */
  webUrl: string | undefined;
}): Record<number, string> {
  const merged: Record<number, string> = { ...(args.cached ?? {}), ...args.fresh };
  if (args.previousWebPort !== undefined && args.previousWebPort !== args.webPort) {
    delete merged[args.previousWebPort];
  }
  if (args.webUrl !== undefined) merged[args.webPort] = args.webUrl;
  return merged;
}
