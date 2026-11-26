import { HANDLE_RE } from '@agentbox/usage-view';

export const validHandle = (handle: string): boolean => HANDLE_RE.test(handle);

/** The route params as a valid handle and share number, or null (a 404). */
export function shareParams(handle: string, n: string): { handle: string; n: number } | null {
  if (!validHandle(handle) || !/^[1-9][0-9]{0,8}$/.test(n)) return null;
  return { handle, n: Number(n) };
}
