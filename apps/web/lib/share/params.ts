import { HANDLE_RE } from '@agentbox/usage-view';

/** The route params as a valid handle and share number, or null (a 404). */
export function shareParams(handle: string, n?: string): { handle: string; n: number } | null {
  if (!HANDLE_RE.test(handle)) return null;
  if (n === undefined) return { handle, n: 0 };
  if (!/^[1-9][0-9]{0,8}$/.test(n)) return null;
  return { handle, n: Number(n) };
}
