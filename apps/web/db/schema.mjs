// Usage shares (agent-box.sh/u/<handle>/<n>). Idempotent: applied lazily by the
// app on first use and by `pnpm db:migrate`.
export const SHARE_DDL = `
CREATE TABLE IF NOT EXISTS handles (
  handle text PRIMARY KEY,
  claim_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shares (
  handle text NOT NULL REFERENCES handles (handle),
  n integer NOT NULL,
  snapshot jsonb NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handle, n)
);
CREATE INDEX IF NOT EXISTS shares_ip_created ON shares (ip_hash, created_at);
`;
