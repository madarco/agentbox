// Usage shares (agent-box.sh/s/<id>).
//
// SHARE_DDL is applied lazily by the app on first use, so it only ever creates.
// SHARE_MIGRATION is `pnpm db:migrate`, run once by hand at setup: it also replaces
// the first version's handle-keyed tables (`handles` + `shares(handle, n)`). It locks
// the old table before checking it, so a write from an old deployment can't land
// between the check and the drop, and it refuses a table that still holds rows.
// Both are idempotent. Sent as one simple query, so it runs as one implicit
// transaction and the lock holds until the new table exists.
export const SHARE_DDL = `
CREATE TABLE IF NOT EXISTS shares (
  id text PRIMARY KEY,
  snapshot jsonb,
  delete_hash text NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS shares_ip_created ON shares (ip_hash, created_at);
`;

export const SHARE_MIGRATION = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'shares' AND column_name = 'handle'
  ) THEN
    LOCK TABLE shares IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM shares) THEN
      RAISE EXCEPTION 'shares still has handle-keyed rows: migrate them by hand';
    END IF;
    DROP TABLE shares;
  END IF;
  DROP TABLE IF EXISTS handles;
END $$;
${SHARE_DDL}`;
