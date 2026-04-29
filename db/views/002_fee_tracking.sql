-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Fee tracking + actual fill data
--
-- Adds three columns to orders, all populated from Kalshi's order response:
--   - filled_count       : actual contracts filled (vs ordered)
--   - fill_cost_dollars  : actual total $ spent on this order (sum of taker
--                          and maker fill costs from Kalshi)
--   - fees_dollars       : actual total fees Kalshi charged (sum of taker
--                          and maker fees from Kalshi)
--
-- Note: order_price_dollars is preserved unchanged. It still means "the limit
-- price the bot bid at." fill_cost_dollars is "what we actually paid." For
-- existing rows where the bot's limit equals the fill (the common case),
-- they'd be the same, but they're conceptually distinct.
--
-- For existing rows, fees_dollars / fill_cost_dollars / filled_count are NULL
-- until backfilled. Views handle this with COALESCE — old rows get treated
-- as zero-fee, with order_price_dollars as the fallback fill cost.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Schema changes ───────────────────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_count INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fill_cost_dollars NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fees_dollars NUMERIC;

-- ── Updated lifetime_stats view ──────────────────────────────────────────────
-- total_pnl is now the fee-adjusted, fill-cost-accurate version.
-- total_pnl_pre_fees is gross (before fees) but still uses real fill cost.
-- total_spent uses real fill cost when available, falls back to limit price.

DROP VIEW IF EXISTS lifetime_stats;

CREATE VIEW lifetime_stats AS
SELECT
    count(*) AS total_orders,
    count(*) FILTER (WHERE settlement_result IN ('yes', 'no'))  AS settled_orders,
    count(*) FILTER (WHERE settlement_result = 'cancelled')     AS cancelled_orders,
    count(*) FILTER (WHERE settlement_result IS NULL)           AS pending_orders,
    count(*) FILTER (WHERE settlement_result = 'yes')           AS total_wins,
    count(*) FILTER (WHERE settlement_result = 'no')            AS total_losses,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) ELSE 0 END
    ), 4) AS total_pnl_pre_fees,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(fees_dollars, 0) ELSE 0 END
    ), 4) AS total_fees,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) - COALESCE(fees_dollars, 0)
             ELSE 0 END
    ), 4) AS total_pnl,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             -- Use real fill cost when present, fall back to limit price
             THEN COALESCE(fill_cost_dollars, order_price_dollars)
             ELSE 0 END
    ), 4) AS total_spent,
    round(
        100.0
        * count(*) FILTER (WHERE settlement_result = 'yes')
        / NULLIF(count(*) FILTER (WHERE settlement_result IN ('yes', 'no')), 0),
        1
    ) AS win_rate_pct,
    round(
        CASE
            WHEN count(*) FILTER (WHERE settlement_result IN ('yes', 'no')) > 0
            THEN sum(CASE WHEN settlement_result IN ('yes', 'no')
                          THEN COALESCE(fill_cost_dollars, order_price_dollars)
                          ELSE 0 END)
                 / count(*) FILTER (WHERE settlement_result IN ('yes', 'no'))
            ELSE NULL
        END,
        4
    ) AS avg_entry_price
FROM orders;

-- ── Updated daily_pnl view ───────────────────────────────────────────────────

DROP VIEW IF EXISTS daily_pnl;

CREATE VIEW daily_pnl AS
SELECT
    date(created_at AT TIME ZONE 'UTC') AS trade_date,
    count(*) AS total_orders,
    count(*) FILTER (WHERE settlement_result = 'yes') AS wins,
    count(*) FILTER (WHERE settlement_result = 'no')  AS losses,
    count(*) FILTER (WHERE settlement_result = 'cancelled') AS cancelled,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(fill_cost_dollars, order_price_dollars)
             ELSE 0 END
    ), 4) AS total_spent,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) ELSE 0 END
    ), 4) AS realized_pnl_pre_fees,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(fees_dollars, 0) ELSE 0 END
    ), 4) AS daily_fees,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) - COALESCE(fees_dollars, 0)
             ELSE 0 END
    ), 4) AS realized_pnl,
    round(
        100.0
        * count(*) FILTER (WHERE settlement_result = 'yes')
        / NULLIF(count(*) FILTER (WHERE settlement_result IN ('yes', 'no')), 0),
        1
    ) AS win_rate_pct
FROM orders
GROUP BY date(created_at AT TIME ZONE 'UTC')
ORDER BY date(created_at AT TIME ZONE 'UTC') DESC;
