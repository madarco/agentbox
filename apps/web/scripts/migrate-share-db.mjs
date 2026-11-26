// Applies the share tables to DATABASE_URL. Idempotent.
import postgres from 'postgres';
import { SHARE_DDL } from '../db/schema.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
await sql.unsafe(SHARE_DDL);
await sql.end();
console.log('share schema applied');
