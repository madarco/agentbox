// Server-side box-ref resolution for `GET /api/v1/boxes?ref=`.
//
// Mirrors the CLI's local resolver (`resolveBoxRef`/`findBox` in
// `packages/sandbox-core/src/state.ts`) so a thin client that missed in its own
// `state.json` gets the SAME matching semantics from the hub — id → unique
// id-prefix → name → displayName → sandbox id, plus numeric project index. The
// hub is the only place holding registered-only boxes (created from another
// machine / the web UI), so this is where a hub-created box is found by name.
//
// Operates on the normalized `Box` view model, which is topology-agnostic (it
// covers both the in-process host backend and the registered-only rows), rather
// than on the raw `BoxRecord` the CLI matcher uses. The `Box` view has no
// `container` field, so the sandbox id (and its `cloud:<id>` container spelling)
// stands in for `findBox`'s container arm.
import type { Box } from './types';

/**
 * Resolve `ref` against the hub's boxes, returning the match SET so the caller
 * can express `findBox`'s three outcomes without arbitrarily picking one:
 *   - `[]`      → no match (none)
 *   - `[box]`   → a unique match (ok)
 *   - `[a, b…]` → an ambiguous id prefix (the caller renders a chooser)
 *
 * `project` (an absolute host project root) enables the numeric project-index
 * arm, exactly as `resolveBoxRef` does when a cwd project is known: a pure
 * positive integer resolves as `projectIndex` within that project and never
 * falls through to id matching (so `3` is the index, not a hex id prefix).
 */
export function resolveBoxRefView(boxes: Box[], ref: string, project?: string): Box[] {
  const q = ref.trim();
  if (q.length === 0) return [];

  // A pure-numeric ref is a project index first (mirrors `resolveBoxRef`): resolve
  // it as one when a project is given. On an index miss — and when no project is
  // given — match a numeric ref ONLY exactly (id / name / displayName / sandbox
  // id), never by id prefix. A bare number is far too collision-prone to
  // prefix-match (`2` would grab `2abc…`, or surface an ambiguous chooser); the
  // one non-index case that matters is a numeric SANDBOX id (hetzner /
  // digitalocean), which the caller types in full. `resolveBoxOrExit` only hits
  // the hub for a numeric ref after its LOCAL project-index lookup already missed,
  // so this never shadows a real local index.
  if (/^[1-9][0-9]*$/.test(q)) {
    if (project !== undefined) {
      const idx = Number.parseInt(q, 10);
      const hit = boxes.find((b) => b.projectRoot === project && b.projectIndex === idx);
      if (hit) return [hit];
    }
    const exact = boxes.find(
      (b) =>
        b.id === q ||
        b.name === q ||
        b.displayName === q ||
        b.sandboxId === q ||
        (b.sandboxId !== undefined && `cloud:${b.sandboxId}` === q),
    );
    return exact ? [exact] : [];
  }

  return findBoxView(boxes, q);
}

/**
 * `findBox`'s precedence on the `Box` view model:
 *   1. exact id
 *   2. unique id prefix (>1 ⇒ ambiguous — return all)
 *   3. exact name
 *   4. exact displayName (cosmetic label)
 *   5. exact sandbox id (or its `cloud:<id>` container spelling)
 */
function findBoxView(boxes: Box[], q: string): Box[] {
  const exactId = boxes.find((b) => b.id === q);
  if (exactId) return [exactId];

  const prefix = boxes.filter((b) => b.id.startsWith(q));
  if (prefix.length === 1) return [prefix[0]!];
  if (prefix.length > 1) return prefix;

  const byName = boxes.find((b) => b.name === q);
  if (byName) return [byName];

  const byDisplayName = boxes.find((b) => b.displayName === q);
  if (byDisplayName) return [byDisplayName];

  const bySandbox = boxes.find(
    (b) => b.sandboxId === q || (b.sandboxId !== undefined && `cloud:${b.sandboxId}` === q),
  );
  if (bySandbox) return [bySandbox];

  return [];
}
