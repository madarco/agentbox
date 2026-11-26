// Applies the share tables to DATABASE_URL, replacing the old handle-keyed ones
// when they are empty. Idempotent; run by hand (`pnpm db:migrate`), never by the app.
import postgres from 'postgres';
import { SHARE_MIGRATION } from '../db/schema.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
await sql.unsafe(SHARE_MIGRATION);
await sql.end();
console.log('share schema applied');
