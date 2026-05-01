"""
kalshi_bot/bot.py
─────────────────
Main entry point for the Kalshi trading bot.
Designed to be run as a daily scheduled task on PythonAnywhere.

Flow:
  1. Mark stale unsettled orders as unknown (>7 days past close)
  2. Update settlements for any past orders that have now resolved
  3. Check kill switch — if disabled, skip order placement (settlements still ran)
  4. Check today's remaining budget
  5. Scan markets closing within 24 hours
  6. Filter by probability, spread, volume, category
  7. Place YES limit orders at midpoint price (up to daily limit)
  8. Write run summary to Supabase (now includes rejection breakdown for diagnostics)
"""

import logging
import sys
from datetime import datetime, timezone

from config import Config
from kalshi_client import KalshiClient
from strategy import qualifies, midpoint_to_cents
from db import Database

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

ROUND_UP_CENTS = True

KNOWN_UNFILLED = {"cancelled", "expired"}
KNOWN_FILLED = {"filled", "executed"}


def extract_fill_data(kalshi_order: dict) -> tuple[float, float, int]:
    """
    Pull fill cost, fees, and count from a Kalshi order response.
    Returns (total_fees_dollars, total_fill_cost_dollars, filled_count).
    """
    def _f(key: str) -> float:
        try:
            return float(kalshi_order.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    taker_fees = _f("taker_fees_dollars")
    maker_fees = _f("maker_fees_dollars")
    total_fees = round(taker_fees + maker_fees, 4)

    taker_cost = _f("taker_fill_cost_dollars")
    maker_cost = _f("maker_fill_cost_dollars")
    total_fill_cost = round(taker_cost + maker_cost, 4)

    try:
        filled = int(float(kalshi_order.get("fill_count_fp") or 0))
    except (TypeError, ValueError):
        filled = 0

    return total_fees, total_fill_cost, filled


def update_settlements(kalshi: KalshiClient, db: Database):
    """Three-phase settlement update: stale cleanup, status check, P&L recording."""
    stale = db.get_stale_unsettled_orders()
    if stale:
        log.warning(
            f"Found {len(stale)} stale order(s) past giveup threshold — "
            f"marking unknown"
        )
        for order in stale:
            db.mark_order_unknown(order["id"])

    unsettled = db.get_unsettled_orders()
    if not unsettled:
        log.info("No unsettled orders to update.")
        return

    log.info(f"Checking settlements for {len(unsettled)} order(s)...")

    for order in unsettled:
        ticker = order.get("ticker", "")
        kalshi_order_id = order.get("kalshi_order_id", "")

        try:
            order_known_filled = False
            fees_dollars = 0.0
            fill_cost_dollars = None
            filled_count = None

            if kalshi_order_id:
                try:
                    kalshi_order = kalshi.get_order(kalshi_order_id)
                    order_status = kalshi_order.get("status", "")

                    if order_status in KNOWN_UNFILLED:
                        db.mark_order_cancelled(order["id"])
                        log.info(
                            f"  ↩ {ticker}: status='{order_status}' → cancelled (pnl=$0.00)"
                        )
                        continue

                    if order_status == "resting":
                        db.mark_order_cancelled(order["id"])
                        log.info(
                            f"  ↩ {ticker}: still resting after close → cancelled (pnl=$0.00)"
                        )
                        continue

                    if order_status == "partially_filled":
                        log.warning(
                            f"  ⚠ {ticker}: status='partially_filled' "
                            f"— needs manual review, skipping"
                        )
                        continue

                    if order_status in KNOWN_FILLED:
                        order_known_filled = True
                        fees_dollars, fill_cost_dollars, filled_count = (
                            extract_fill_data(kalshi_order)
                        )
                    else:
                        log.warning(
                            f"  ⚠ {ticker}: unexpected status='{order_status}' "
                            f"— skipping, will retry next run"
                        )
                        continue

                except Exception as e:
                    log.warning(
                        f"  {ticker}: could not fetch order ({e}), "
                        f"falling back to market result check..."
                    )
                    order_known_filled = True
            else:
                log.debug(f"  {ticker}: no kalshi_order_id, trying market result")
                order_known_filled = True

            if not order_known_filled:
                continue

            market = kalshi.get_market(ticker)
            result = market.get("result", "")

            if result in ("yes", "no"):
                effective_fill_cost = (
                    fill_cost_dollars
                    if fill_cost_dollars is not None
                    else float(order.get("order_price_dollars") or 0)
                )
                effective_count = (
                    filled_count
                    if filled_count is not None
                    else int(order.get("contracts") or 1)
                )

                payout = (1.0 if result == "yes" else 0.0) * effective_count
                pnl = round(payout - effective_fill_cost, 4)
                net_pnl = round(pnl - fees_dollars, 4)

                db.update_settlement(
                    order_id=order["id"],
                    result=result,
                    payout_dollars=payout,
                    pnl_dollars=pnl,
                    fees_dollars=fees_dollars,
                    fill_cost_dollars=fill_cost_dollars,
                    filled_count=filled_count,
                )
                log.info(
                    f"  ✓ {ticker}: {result.upper()} | "
                    f"fill_cost=${effective_fill_cost:.4f} payout=${payout:.4f} "
                    f"gross=${pnl:+.4f} fees=${fees_dollars:.4f} "
                    f"net=${net_pnl:+.4f}"
                )
            else:
                log.debug(
                    f"  {ticker}: market result not yet available ('{result}')"
                )

        except Exception as e:
            log.warning(f"  Could not process {ticker}: {e}")


def run():
    config = Config()
    kalshi = KalshiClient(config)
    db = Database(config)

    mode_label = "DEMO" if config.demo_mode else "LIVE"
    log.info(f"{'='*55}")
    log.info(f"  Kalshi Bot — {mode_label} mode")
    log.info(f"  Daily limit: ${config.daily_spend_limit:.2f} | "
             f"Range: {config.min_probability*100:.0f}%–{config.max_probability*100:.0f}%")
    if config.excluded_categories:
        log.info(f"  Excluded categories: {', '.join(config.excluded_categories)}")
    log.info(f"{'='*55}")

    update_settlements(kalshi, db)

    trading_enabled = db.is_trading_enabled()
    if not trading_enabled:
        log.warning(
            "⚠ Kill switch is ON — trading_enabled=false. "
            "Settlements ran, but skipping new order placement."
        )
        db.insert_run(
            {
                "run_at": datetime.now(timezone.utc).isoformat(),
                "markets_evaluated": 0,
                "orders_attempted": 0,
                "orders_placed": 0,
                "total_spent_dollars": 0,
                "daily_limit_dollars": config.daily_spend_limit,
                "demo_mode": config.demo_mode,
                "rejection_breakdown": {"kill_switch": "active"},
            }
        )
        log.info(f"{'='*55}")
        log.info("  Run complete: trading disabled, 0 orders placed")
        log.info(f"{'='*55}")
        kalshi.close()
        return

    todays_spend = db.get_todays_spend()
    remaining_budget = config.daily_spend_limit - todays_spend
    log.info(
        f"Today's spend so far: ${todays_spend:.4f} | "
        f"Remaining: ${remaining_budget:.4f}"
    )

    if remaining_budget <= 0:
        log.info("Daily spend limit already reached. Exiting.")
        kalshi.close()
        return

    now_ts = int(datetime.now(timezone.utc).timestamp())
    min_close_ts = now_ts
    max_close_ts = now_ts + (config.hours_to_close * 3600)

    log.info(f"Scanning markets closing within {config.hours_to_close} hours...")
    try:
        markets = kalshi.get_markets(
            max_close_ts=max_close_ts,
            min_close_ts=min_close_ts,
        )
    except Exception as e:
        log.error(f"Failed to fetch markets: {e}")
        kalshi.close()
        return

    log.info(f"Total markets returned: {len(markets)}")

    already_ordered = db.get_todays_tickers()
    qualifying = []
    reject_counts: dict[str, int] = {}

    for market in markets:
        ok, midpoint, reason = qualifies(market, config, already_ordered)
        if ok:
            qualifying.append((market, midpoint))
        else:
            bucket = reason.split(":")[0]
            reject_counts[bucket] = reject_counts.get(bucket, 0) + 1

    log.info(f"Qualifying markets: {len(qualifying)}")
    if reject_counts:
        log.info(f"Rejection breakdown: {reject_counts}")

    # Track placement-loop outcomes too — useful for diagnosing why budget
    # wasn't fully spent (e.g., "16 placed, 4 failed, 32 not reached")
    placement_outcomes = {
        "placed": 0,
        "failed": 0,
        "stopped_at_budget": 0,
        "not_reached": len(qualifying),
    }

    run_id = db.insert_run(
        {
            "run_at": datetime.now(timezone.utc).isoformat(),
            "markets_evaluated": len(markets),
            "orders_attempted": len(qualifying),
            "orders_placed": 0,
            "total_spent_dollars": 0,
            "daily_limit_dollars": config.daily_spend_limit,
            "demo_mode": config.demo_mode,
        }
    )

    orders_placed = 0
    session_spend = 0.0

    for market, midpoint in qualifying:
        ticker = market["ticker"]

        yes_price_cents = midpoint_to_cents(midpoint, round_up=ROUND_UP_CENTS)
        order_cost = (yes_price_cents / 100) * config.contracts_per_order

        if todays_spend + session_spend + order_cost > config.daily_spend_limit:
            log.info(
                f"Next order (${order_cost:.4f}) would exceed daily limit. Stopping."
            )
            placement_outcomes["stopped_at_budget"] = 1
            break

        # We're attempting this market — decrement "not_reached"
        placement_outcomes["not_reached"] -= 1

        try:
            order = kalshi.place_limit_order(
                ticker=ticker,
                yes_price_cents=yes_price_cents,
                count=config.contracts_per_order,
            )
            kalshi_order_id = order.get("order_id", "")
            order_status = order.get("status", "resting")

            db.insert_order(
                {
                    "run_id": run_id,
                    "kalshi_order_id": kalshi_order_id,
                    "ticker": ticker,
                    "event_ticker": market.get("event_ticker", ""),
                    "market_title": market.get("title", ""),
                    "category": market.get("category", ""),
                    "yes_bid_dollars": float(market.get("yes_bid_dollars") or 0),
                    "yes_ask_dollars": float(market.get("yes_ask_dollars") or 0),
                    "midpoint_dollars": round(midpoint, 4),
                    "order_price_dollars": round(yes_price_cents / 100, 2),
                    "contracts": config.contracts_per_order,
                    "status": order_status,
                    "close_time": market.get("close_time"),
                    "expiration_time": market.get("latest_expiration_time"),
                }
            )

            orders_placed += 1
            session_spend += order_cost
            placement_outcomes["placed"] += 1
            log.info(
                f"  ✓ {ticker:40s} "
                f"midpoint={midpoint:.4f} "
                f"limit={yes_price_cents}¢ "
                f"id={kalshi_order_id}"
            )

        except Exception as e:
            log.error(f"  ✗ Order failed for {ticker}: {e}")
            placement_outcomes["failed"] += 1

    # Combine market-filter rejections + placement-loop outcomes into one dict
    full_breakdown = {**reject_counts, **placement_outcomes}

    db.update_run(
        run_id,
        {
            "orders_placed": orders_placed,
            "total_spent_dollars": round(session_spend, 4),
            "rejection_breakdown": full_breakdown,
        },
    )

    log.info(f"{'='*55}")
    log.info(
        f"  Run complete: {orders_placed} order(s) placed, "
        f"${session_spend:.4f} spent this session"
    )
    log.info(f"  Placement: {placement_outcomes}")
    log.info(f"{'='*55}")

    kalshi.close()


if __name__ == "__main__":
    run()