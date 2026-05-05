"""
kalshi_bot/bot.py
─────────────────
Main entry point for the Kalshi trading bot.
Designed to be run as a daily scheduled task on PythonAnywhere.

Flow:
  1. Mark stale unsettled orders as unknown (>7 days past close)
  2. Fetch recent Kalshi settlements (ground truth for fill data)
  3. Update settlements for past orders using settlements as primary source
  4. Check kill switch — if disabled, skip order placement
  5. Check today's remaining budget
  6. Scan markets closing within 24 hours
  7. Fetch events for the same window to get category labels
  8. Filter by probability, spread, volume, category
  9. Place YES limit orders at midpoint price (up to daily limit)
  10. Write run summary to Supabase

Settlement strategy:
  The /portfolio/orders/{id} endpoint returns 404 for archived (settled) orders.
  The /portfolio/settlements endpoint is the ground truth — if a ticker appears
  there, the order was filled and we have exact fill cost, fees, and payout.
  We use settlements as the PRIMARY path and only fall back to the order status
  endpoint to catch cancellations (orders that never filled).
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


def _parse_dollar_str(value) -> float:
    """Safely parse a dollar string like '0.660000' to float."""
    try:
        return round(float(value or 0), 4)
    except (TypeError, ValueError):
        return 0.0


def update_settlements(kalshi: KalshiClient, db: Database):
    """
    Three-phase settlement update.

    Phase 1: Mark stale orders (>7 days past close) as unknown — give up.
    Phase 2: Fetch Kalshi settlements as ground truth. For each unsettled
             order that appears in settlements, record exact fill data.
    Phase 3: For orders NOT in settlements (still pending or cancelled),
             check the order status endpoint to catch cancellations.
    """

    # ── Phase 1: Stale cleanup ─────────────────────────────────────────────
    stale = db.get_stale_unsettled_orders()
    if stale:
        log.warning(
            f"Found {len(stale)} stale order(s) past giveup threshold — "
            f"marking unknown"
        )
        for order in stale:
            db.mark_order_unknown(order["id"])

    # ── Phase 2: Settlement via Kalshi settlements endpoint ────────────────
    unsettled = db.get_unsettled_orders()
    if not unsettled:
        log.info("No unsettled orders to update.")
        return

    log.info(f"Checking settlements for {len(unsettled)} order(s)...")

    # Fetch recent settlements from Kalshi — newest first.
    # 500 covers ~16 days at $30/day / ~$0.70 avg = ~43 orders/day.
    # More than enough headroom for the 7-day giveup window.
    try:
        kalshi_settlements = kalshi.get_settlements(limit=500)
        # Build lookup: ticker → settlement record
        # Note: a ticker should only appear once in settlements (one resolution).
        settlement_by_ticker: dict[str, dict] = {
            s["ticker"]: s
            for s in kalshi_settlements
            if s.get("ticker")
        }
        log.info(
            f"Fetched {len(kalshi_settlements)} recent Kalshi settlements "
            f"({len(settlement_by_ticker)} unique tickers)"
        )
    except Exception as e:
        log.warning(
            f"Could not fetch Kalshi settlements ({e}) — "
            f"falling back to order-status-only checks for this run"
        )
        settlement_by_ticker = {}

    # Process each unsettled order
    for order in unsettled:
        ticker = order.get("ticker", "")
        kalshi_order_id = order.get("kalshi_order_id", "")

        # ── PRIMARY PATH: ticker found in Kalshi settlements ──────────────
        # This means the order was filled and the market has resolved.
        # The settlement record has exact fill cost, fees, and payout.
        if ticker in settlement_by_ticker:
            s = settlement_by_ticker[ticker]
            result = s.get("market_result", "")

            if result not in ("yes", "no"):
                log.warning(
                    f"  ⚠ {ticker}: unexpected market_result='{result}' "
                    f"in settlement — skipping"
                )
                continue

            # Parse all values — costs are dollar strings, revenue is cents int
            filled_count = int(float(s.get("yes_count_fp", "0") or "0"))
            fill_cost_dollars = _parse_dollar_str(s.get("yes_total_cost_dollars"))
            fees_dollars = _parse_dollar_str(s.get("fee_cost"))
            payout_dollars = round(int(s.get("revenue", 0)) / 100, 4)
            pnl_dollars = round(payout_dollars - fill_cost_dollars, 4)
            net_pnl = round(pnl_dollars - fees_dollars, 4)

            db.update_settlement(
                order_id=order["id"],
                result=result,
                payout_dollars=payout_dollars,
                pnl_dollars=pnl_dollars,
                fees_dollars=fees_dollars,
                fill_cost_dollars=fill_cost_dollars,
                filled_count=filled_count,
            )
            log.info(
                f"  ✓ {ticker}: {result.upper()} | "
                f"fill_cost=${fill_cost_dollars:.4f} payout=${payout_dollars:.4f} "
                f"gross=${pnl_dollars:+.4f} fees=${fees_dollars:.4f} "
                f"net=${net_pnl:+.4f} [settlements]"
            )
            continue

        # ── FALLBACK PATH: ticker not in settlements ───────────────────────
        # The market hasn't resolved yet (still open/pending), or the order
        # was cancelled/expired without filling (no settlement record exists
        # for unfilled orders). Check the order status endpoint to distinguish.
        if not kalshi_order_id:
            log.debug(f"  {ticker}: not in settlements, no order ID — skipping")
            continue

        try:
            kalshi_order = kalshi.get_order(kalshi_order_id)
            order_status = kalshi_order.get("status", "")

            if order_status in KNOWN_UNFILLED:
                db.mark_order_cancelled(order["id"])
                log.info(
                    f"  ↩ {ticker}: status='{order_status}' → cancelled (pnl=$0.00)"
                )
            elif order_status == "resting":
                # Still sitting in the order book waiting to match.
                # Market hasn't closed yet (or just closed and hasn't settled).
                log.debug(
                    f"  {ticker}: still resting — market hasn't settled yet, will retry"
                )
            elif order_status == "partially_filled":
                log.warning(
                    f"  ⚠ {ticker}: partially_filled — needs manual review, skipping"
                )
            else:
                # Filled/executed but not in the settlements window yet.
                # Can happen if market resolved very recently. Retry next run.
                log.debug(
                    f"  {ticker}: status='{order_status}' but not in settlements yet — "
                    f"will retry next run"
                )

        except Exception as e:
            # 404 = order archived but not in our 500-record settlements window.
            # This is unusual (would mean >500 settlements since this order placed).
            # The stale check will eventually catch and mark it unknown.
            log.debug(
                f"  {ticker}: order endpoint error ({type(e).__name__}) and "
                f"not in recent settlements — skipping until stale threshold"
            )


def build_category_lookup(
    kalshi: KalshiClient,
    max_close_ts: int,
    min_close_ts: int,
) -> dict[str, str]:
    """
    Fetch events for the current time window and return event_ticker -> category.

    Why: Kalshi's /markets endpoint does not include a 'category' field.
    Category is on the parent event object. Called once per run.

    Fails safely: returns empty dict on error. Orders insert with empty category.
    """
    try:
        events = kalshi.get_events(
            max_close_ts=max_close_ts,
            min_close_ts=min_close_ts,
        )
        lookup = {
            e.get("event_ticker", ""): e.get("category", "")
            for e in events
            if e.get("event_ticker")
        }
        log.info(f"Category lookup built: {len(lookup)} events")
        return lookup
    except Exception as e:
        log.warning(
            f"Could not fetch events for category lookup ({e}) — "
            f"orders will have empty category this run"
        )
        return {}


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

    category_by_event = build_category_lookup(kalshi, max_close_ts, min_close_ts)

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

        placement_outcomes["not_reached"] -= 1

        try:
            order = kalshi.place_limit_order(
                ticker=ticker,
                yes_price_cents=yes_price_cents,
                count=config.contracts_per_order,
            )
            kalshi_order_id = order.get("order_id", "")
            order_status = order.get("status", "resting")

            event_ticker = market.get("event_ticker", "")
            category = category_by_event.get(event_ticker, "")

            db.insert_order(
                {
                    "run_id": run_id,
                    "kalshi_order_id": kalshi_order_id,
                    "ticker": ticker,
                    "event_ticker": event_ticker,
                    "market_title": market.get("title", ""),
                    "category": category,
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
                f"cat={category or '—':20s} "
                f"midpoint={midpoint:.4f} "
                f"limit={yes_price_cents}¢ "
                f"id={kalshi_order_id}"
            )

        except Exception as e:
            log.error(f"  ✗ Order failed for {ticker}: {e}")
            placement_outcomes["failed"] += 1

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