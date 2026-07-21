/**
 * The label to show for a box: its cosmetic `displayName` (set via
 * `agentbox status <box> --set-name`) when present, else the structural `name`.
 * `name` still drives the container / git branch / URL — this is display only.
 */
export function boxLabel(box: { name: string; displayName?: string }): string {
  const custom = box.displayName?.trim();
  return custom ? custom : box.name;
}
