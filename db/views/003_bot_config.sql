-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003: Bot configuration table (kill switch + future settings)
--
-- Stores runtime-mutable bot settings that the dashboard can change without
-- requiring a redeploy or SSH access.
--
-- Schema is intentionally generic key/value (TEXT) so future settings can
-- live alongside trading_enabled without further migrations.
--
-- Initial seed: trading_enabled = 'true'
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the kill switch in the enabled state.
-- ON CONFLICT DO NOTHING means re-running this migration is safe.
INSERT INTO bot_config (key, value)
VALUES ('trading_enabled', 'true')
ON CONFLICT (key) DO NOTHING;


-- ── Row Level Security ───────────────────────────────────────────────────────
-- Without RLS, the public anon key can read AND write this table from any
-- browser. We want reads to be public (dashboard needs to display current
-- state) but writes restricted to the service-role key (used by the bot
-- and the /api/toggle-trading route).

ALTER TABLE bot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON bot_config
  FOR SELECT
  TO anon, authenticated
  USING (true);
