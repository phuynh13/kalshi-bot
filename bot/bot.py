"""
kalshi_bot/bot.py
─────────────────
Main entry point for the Kalshi trading bot.
Designed to be run as a daily scheduled task on PythonAnywhere.

Flow:
  1. Mark stale unsettled orders as unknown (>7 days past close)
  2. Update settlements for any past orders that have now resolved
  3. Check today's remaining budget
  4. Scan markets closing within 24 hours
  5. Filter by probability, spread, volume, category
  6. Place YES limit orders at midpoint price (up to daily limit)
  7. Write run summary to Supabase
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

# Set to True to always ceil on half-cent midpoints (agreed during setup)
ROUND_UP_CENTS = True

# ── Kalshi order status taxonomy ──────────────────────────────────────────────
# Whitelist approach: every status the bot has explicit logic for goes here.
# Anything not in either set is logged and skipped (will retry next run, or
# eventually time out via the stale-order cleanup in update_settlements).

# Order never filled — no money committed, no position opened
KNOWN_UNFILLED = {"cancelled", "expired"}

# Order fully executed — proceed to market-result settlement
KNOWN_FILLED = {"filled", "executed"}


# ── Settlement updater ────────────────────────────────────────────────────────

def update_settlements(kalshi: KalshiClient, db: Database):
    """
    Three-phase settlement update:

    Phase 0 — Garbage collect stale orders that are way past their close_time
              (>7 days). These are zombies — Kalshi never resolved them and
              retrying every run wastes API calls.

    Phase 1 — For each remaining unsettled order, check the Kalshi order status.
              Whitelist: explicitly handle filled, cancelled, expired, resting,
              partially_filled. Anything else is logged and skipped for retry.

    Phase 2 — If the order was filled, fetch the market result and
              compute actual P&L (payout - entry_price).
    """
    # ── Phase 0: clean up zombies before doing real work ──────────────────────
    stale = db.get_stale_unsettled_orders()
    if stale:
        log.warning(
            f"Found {len(stale)} stale order(s) past giveup threshold — "
            f"marking unknown"
        )
        for order in stale:
            db.mark_order_unknown(order["id"])

    # ── Phase 1 & 2: normal settlement for orders within the giveup window ────
    unsettled = db.get_unsettled_orders()
    if not unsettled:
        log.info("No unsettled orders to update.")
        return

    log.info(f"Checking settlements for {len(unsettled)} order(s)...")

    for order in unsettled:
        ticker = order.get("ticker", "")
        kalshi_order_id = order.get("kalshi_order_id", "")

        try:
            # ── Phase 1: classify the order's current status ──────────────────
            order_known_filled = False  # set True only if we should proceed to Phase 2

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
                        # TODO: handle properly once filled_count is tracked.
                        # For now, skip — the order will retry next run and
                        # eventually time out via stale cleanup if it stays in
                        # this state. Worth a manual look if this ever fires.
                        log.warning(
                            f"  ⚠ {ticker}: status='partially_filled' "
                            f"— needs manual review, skipping"
                        )
                        continue

                    if order_status in KNOWN_FILLED:
                        order_known_filled = True
                        log.debug(
                            f"  {ticker}: order status='{order_status}', "
                            f"checking market result..."
                        )
                    else:
                        # Unknown / new status — quarantine, don't guess
                        log.warning(
                            f"  ⚠ {ticker}: unexpected status='{order_status}' "
                            f"— skipping, will retry next run"
                        )
                        continue

                except Exception as e:
                    # API failure on the status check — fall through to market
                    # result lookup as a best-effort. If the market has settled,
                    # we'll record P&L; otherwise the order stays pending.
                    log.warning(
                        f"  {ticker}: could not fetch order ({e}), "
                        f"falling back to market result check..."
                    )
                    order_known_filled = True  # best-effort: assume filled

            else:
                # No kalshi_order_id stored — old data or insert race.
                # Best-effort: try to settle against the market result.
                log.debug(f"  {ticker}: no kalshi_order_id, trying market result")
                order_known_filled = True

            # Skip Phase 2 if we couldn't confirm the order should be settled
            if not order_known_filled:
                continue

            # ── Phase 2: resolve filled order against market outcome ──────────
            market = kalshi.get_market(ticker)
            result = market.get("result", "")

            if result in ("yes", "no"):
                entry_price = float(order.get("order_price_dollars") or 0)
                payout = 1.0 if result == "yes" else 0.0
                pnl = payout - entry_price
                db.update_settlement(order["id"], result, payout, pnl)
                log.info(
                    f"  ✓ {ticker}: {result.upper()} | "
                    f"entry=${entry_price:.2f} payout=${payout:.2f} pnl=${pnl:+.4f}"
                )
            else:
                log.debug(
                    f"  {ticker}: market result not yet available ('{result}')"
                )

        except Exception as e:
            log.warning(f"  Could not process {ticker}: {e}")




# ── Main bot run ──────────────────────────────────────────────────────────────

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

    # ── Step 1: Update past settlements (includes stale-order cleanup) ────────
    update_settlements(kalshi, db)

    # ── Step 2: Check today's budget ──────────────────────────────────────────
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

    # ── Step 3: Fetch markets ─────────────────────────────────────────────────
    now_ts = int(datetime.now(timezone.utc).timestamp())
    # min_close_ts = now so we don't catch markets that already closed
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

    # ── Step 4: Apply filters ─────────────────────────────────────────────────
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

    # ── Step 5: Create run record ─────────────────────────────────────────────
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

    # ── Step 6: Place orders ──────────────────────────────────────────────────
    orders_placed = 0
    session_spend = 0.0

    for market, midpoint in qualifying:
        ticker = market["ticker"]

        # Compute the ACTUAL price we'll bid at (rounded up per ROUND_UP_CENTS)
        # before doing anything else, so the budget check matches reality.
        yes_price_cents = midpoint_to_cents(midpoint, round_up=ROUND_UP_CENTS)
        order_cost = (yes_price_cents / 100) * config.contracts_per_order

        # Stop if adding this order would exceed the daily limit
        if todays_spend + session_spend + order_cost > config.daily_spend_limit:
            log.info(
                f"Next order (${order_cost:.4f}) would exceed daily limit. Stopping."
            )
            break

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
            log.info(
                f"  ✓ {ticker:40s} "
                f"midpoint={midpoint:.4f} "
                f"limit={yes_price_cents}¢ "
                f"id={kalshi_order_id}"
            )

        except Exception as e:
            log.error(f"  ✗ Order failed for {ticker}: {e}")

    # ── Step 7: Finalize run record ───────────────────────────────────────────
    db.update_run(
        run_id,
        {
            "orders_placed": orders_placed,
            "total_spent_dollars": round(session_spend, 4),
        },
    )

    log.info(f"{'='*55}")
    log.info(
        f"  Run complete: {orders_placed} order(s) placed, "
        f"${session_spend:.4f} spent this session"
    )
    log.info(f"{'='*55}")

    kalshi.close()


if __name__ == "__main__":
    run()
