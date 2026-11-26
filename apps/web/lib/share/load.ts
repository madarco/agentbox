import { cache } from 'react';
import { shareParams } from './params';
import { db, getShare } from './store';

/** One share by its route params, read once per request (page, metadata and image share it). */
export const loadShare = cache(async (handle: string, n: string) => {
  const p = shareParams(handle, n);
  const sql = db();
  if (!p || !sql) return null;
  return getShare(sql, p.handle, p.n);
});
