-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Add rejection_breakdown to runs
--
-- The bot already computes a rejection breakdown each run (e.g., how many
-- markets failed because of low_volume, spread_too_wide, etc.) but only
-- prints it to logs. This stores it on the run row so the dashboard can
-- display the full evaluated → qualified → placed funnel.
--
-- Format:
--   {"low_volume": 3339, "spread_too_wide": 93, "probability_out_of_range": 544}
--
-- Existing rows will have NULL for this field — the dashboard handles that.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE runs ADD COLUMN IF NOT EXISTS rejection_breakdown JSONB;
