// Usage shares (agent-box.sh/s/<id>). Idempotent: applied lazily by the app on first
// use and by `pnpm db:migrate`.
//
// The first version keyed shares by a claimed handle (`handles` + `shares(handle, n)`).
// That shape is dropped when found, but only while it holds no share: a non-empty old
// table stops the migration instead of losing data.
export const SHARE_DDL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'shares' AND column_name = 'handle'
  ) THEN
    IF EXISTS (SELECT 1 FROM shares) THEN
      RAISE EXCEPTION 'shares still has handle-keyed rows: migrate them by hand';
    END IF;
    DROP TABLE shares;
  END IF;
  DROP TABLE IF EXISTS handles;
END $$;
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
