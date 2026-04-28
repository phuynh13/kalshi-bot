import math
import logging
from typing import Optional
from config import Config

log = logging.getLogger(__name__)


# ── Price helpers ──────────────────────────────────────────────────────────────

def _safe_float(value) -> Optional[float]:
    """
    Parse a dollar string or numeric value safely, returning None on failure.

    Note: 0.0 is a VALID value (e.g. an empty bid side on Kalshi means
    "nobody is bidding YES right now" — that's real information, not missing data).
    Only None, non-numeric, or negative values are treated as invalid.
    """
    try:
        v = float(value)
        return v if v >= 0 else None
    except (TypeError, ValueError):
        return None


def calculate_midpoint(market: dict) -> Optional[float]:
    """
    Calculate the best available price estimate for the market.

    Primary:  midpoint of yes_bid_dollars and yes_ask_dollars (live markets
              with an active order book — most accurate).
    Fallback: last_price_dollars when bid/ask are both zero or missing
              (common in the demo environment where most markets have no
              active quotes but do have a last traded price).

    Returns None if no usable price data exists at all.
    """
    bid = _safe_float(market.get("yes_bid_dollars"))
    ask = _safe_float(market.get("yes_ask_dollars"))

    # Primary: use midpoint when both sides are available and valid
    if bid is not None and ask is not None and ask >= bid:
        return (bid + ask) / 2

    # Fallback: last traded price (useful in demo / thin markets)
    last = _safe_float(market.get("last_price_dollars"))
    if last is not None:
        return last

    return None


def calculate_spread(market: dict) -> Optional[float]:
    """Calculate the dollar spread between yes_ask and yes_bid."""
    bid = _safe_float(market.get("yes_bid_dollars"))
    ask = _safe_float(market.get("yes_ask_dollars"))
    if bid is None or ask is None:
        return None
    return ask - bid


def midpoint_to_cents(
    midpoint: float,
    round_down: bool = False,
    round_up: bool = False,
) -> int:
    """
    Convert a dollar midpoint to integer cents for the order endpoint.

    Args:
        midpoint:   Dollar price (e.g. 0.625)
        round_down: Always floor  (0.625 → 62¢). Conservative entry.
        round_up:   Always ceil   (0.625 → 63¢). Default per user config.
        Neither:    Round nearest (0.625 → 63¢ via banker's rounding).

    Returns:
        Integer cents clamped to [1, 99].
    """
    raw = midpoint * 100
    if round_down:
        cents = math.floor(raw)
    elif round_up:
        cents = math.ceil(raw)
    else:
        cents = round(raw)
    return max(1, min(99, cents))


# ── Market qualification ───────────────────────────────────────────────────────

def qualifies(
    market: dict,
    config: Config,
    already_ordered_tickers: set,
) -> tuple[bool, Optional[float], str]:
    """
    Determine whether a market qualifies for an order.

    Returns:
        (passes: bool, midpoint: float | None, reason: str)
        reason is "ok" on pass, or a short descriptor on fail.
    """
    ticker = market.get("ticker", "")

    # ── Duplicate guard ────────────────────────────────────────────────────────
    if ticker in already_ordered_tickers:
        return False, None, "already_ordered_today"

    # ── Market must be open/active ─────────────────────────────────────────────
    # Kalshi uses "open" in production and "active" in the demo environment
    OPEN_STATUSES = {"open", "active"}
    if market.get("status") not in OPEN_STATUSES:
        return False, None, f"status={market.get('status')}"

    # ── Category exclusion ─────────────────────────────────────────────────────
    category = (market.get("category") or "").strip()
    if category in config.excluded_categories:
        return False, None, f"excluded_category:{category}"

    # ── Minimum 24h volume ─────────────────────────────────────────────────────
    try:
        volume_24h = float(market.get("volume_24h_fp") or 0)
    except (TypeError, ValueError):
        volume_24h = 0.0
    if volume_24h < config.min_volume_24h:
        return False, None, f"low_volume:{volume_24h:.0f}"

    # ── Compute midpoint ───────────────────────────────────────────────────────
    bid = _safe_float(market.get("yes_bid_dollars"))
    ask = _safe_float(market.get("yes_ask_dollars"))
    has_order_book = bid is not None and ask is not None and ask >= bid

    midpoint = calculate_midpoint(market)
    if midpoint is None:
        return False, None, "no_valid_bid_ask"

    # ── Spread guard (only applies when a real order book exists) ──────────────
    if has_order_book:
        spread = calculate_spread(market)
        if spread is not None and spread > config.max_spread:
            return False, None, f"spread_too_wide:{spread:.4f}"

    # ── Probability range ──────────────────────────────────────────────────────
    if not (config.min_probability <= midpoint <= config.max_probability):
        return False, None, f"probability_out_of_range:{midpoint:.4f}"

    return True, midpoint, "ok"
