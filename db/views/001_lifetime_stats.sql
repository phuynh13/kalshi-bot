-- ─────────────────────────────────────────────────────────────────────────────
-- lifetime_stats view — updated during the audit session
-- Adds pending_orders and avg_entry_price (computed in SQL, not the dashboard)
--
-- Run this once in the Supabase SQL editor. CREATE OR REPLACE preserves
-- column order constraints — new columns must be appended at the end.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW lifetime_stats AS
SELECT
    count(*) AS total_orders,
    count(*) FILTER (WHERE settlement_result IN ('yes', 'no'))  AS settled_orders,
    count(*) FILTER (WHERE settlement_result = 'cancelled')     AS cancelled_orders,
    count(*) FILTER (WHERE settlement_result = 'yes')           AS total_wins,
    count(*) FILTER (WHERE settlement_result = 'no')            AS total_losses,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) ELSE 0 END
    ), 4) AS total_pnl,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN order_price_dollars ELSE 0 END
    ), 4) AS total_spent,
    round(
        100.0
        * count(*) FILTER (WHERE settlement_result = 'yes')
        / NULLIF(count(*) FILTER (WHERE settlement_result IN ('yes', 'no')), 0),
        1
    ) AS win_rate_pct,
    -- New columns (appended below) ────────────────────────────────────────────
    count(*) FILTER (WHERE settlement_result IS NULL)           AS pending_orders,
    round(
        CASE
            WHEN count(*) FILTER (WHERE settlement_result IN ('yes', 'no')) > 0
            THEN sum(CASE WHEN settlement_result IN ('yes', 'no')
                          THEN order_price_dollars ELSE 0 END)
                 / count(*) FILTER (WHERE settlement_result IN ('yes', 'no'))
            ELSE NULL
        END,
        4
    ) AS avg_entry_price
FROM orders;
