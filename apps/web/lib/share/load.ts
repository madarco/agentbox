import { cache } from 'react';
import { validShareId } from './params';
import { db, getShare } from './store';

/** One share by its id, read once per request (page, metadata and image share it). */
export const loadShare = cache(async (id: string) => {
  const sql = db();
  if (!validShareId(id) || !sql) return null;
  return getShare(sql, id);
});
