-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Per-category performance breakdown
--
-- Adds a view that aggregates orders by category, similar in shape to
-- lifetime_stats but grouped. Drives the dashboard's "Performance by category"
-- panel — answers questions like "which categories should I exclude or focus on?"
--
-- Categories with very few settled orders show high noise — the dashboard
-- de-emphasizes those visually but we still include them so emerging
-- categories are visible.
--
-- Excludes pending orders (no outcome yet) and the empty-string category
-- (orders where Kalshi returned no category — usually a few outliers).
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS category_stats;

CREATE VIEW category_stats AS
SELECT
    COALESCE(NULLIF(category, ''), 'Uncategorized') AS category,
    count(*) FILTER (WHERE settlement_result IN ('yes', 'no'))      AS settled_orders,
    count(*) FILTER (WHERE settlement_result = 'cancelled')         AS cancelled_orders,
    count(*) FILTER (WHERE settlement_result IS NULL)               AS pending_orders,
    count(*) FILTER (WHERE settlement_result = 'yes')               AS wins,
    count(*) FILTER (WHERE settlement_result = 'no')                AS losses,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(fill_cost_dollars, order_price_dollars)
             ELSE 0 END
    ), 4) AS total_spent,
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(fees_dollars, 0) ELSE 0 END
    ), 4) AS total_fees,
    -- Net P&L: gross - fees (matches the lifetime_stats convention)
    round(sum(
        CASE WHEN settlement_result IN ('yes', 'no')
             THEN COALESCE(pnl_dollars, 0) - COALESCE(fees_dollars, 0)
             ELSE 0 END
    ), 4) AS net_pnl,
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
FROM orders
GROUP BY COALESCE(NULLIF(category, ''), 'Uncategorized')
ORDER BY count(*) FILTER (WHERE settlement_result IN ('yes', 'no')) DESC;
