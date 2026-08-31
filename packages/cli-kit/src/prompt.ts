// Thin wrapper around @clack/prompts whose interactive input prompts quit the
// process on Ctrl+C instead of returning the cancel symbol. Without it, the
// historical `if (isCancel(x) || !x)` pattern at every call site silently
// mapped Ctrl+C onto a "No" answer and the command kept going.
//
// Re-exports the rest of the surface (log, spinner, intro, outro, note, cancel,
// isCancel, group, tasks, …) unchanged so callers swap a single import line.

import {
  cancel as clackCancel,
  confirm as clackConfirm,
  groupMultiselect as clackGroupMultiselect,
  isCancel,
  multiselect as clackMultiselect,
  password as clackPassword,
  select as clackSelect,
  selectKey as clackSelectKey,
  text as clackText,
  type ConfirmOptions,
  type GroupMultiSelectOptions,
  type MultiSelectOptions,
  type PasswordOptions,
  type SelectOptions,
  type TextOptions,
} from '@clack/prompts';

export * from '@clack/prompts';

// 128 + SIGINT (the conventional Ctrl+C exit code).
function onCancel(): never {
  clackCancel('Cancelled.');
  process.exit(130);
}

export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  const v = await clackConfirm(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function select<Value>(opts: SelectOptions<Value>): Promise<Value> {
  const v = await clackSelect<Value>(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function selectKey<Value extends string>(opts: SelectOptions<Value>): Promise<Value> {
  const v = await clackSelectKey<Value>(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function multiselect<Value>(opts: MultiSelectOptions<Value>): Promise<Value[]> {
  const v = await clackMultiselect<Value>(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function groupMultiselect<Value>(
  opts: GroupMultiSelectOptions<Value>,
): Promise<Value[]> {
  const v = await clackGroupMultiselect<Value>(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function text(opts: TextOptions): Promise<string> {
  const v = await clackText(opts);
  if (isCancel(v)) onCancel();
  return v;
}

export async function password(opts: PasswordOptions): Promise<string> {
  const v = await clackPassword(opts);
  if (isCancel(v)) onCancel();
  return v;
}
