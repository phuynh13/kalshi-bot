import logging
from datetime import datetime, timezone, timedelta
from supabase import create_client, Client
from config import Config

log = logging.getLogger(__name__)

# After this many days past close_time with no settlement, give up trying.
# Kalshi normally settles within 1-15 hours, with combo/manual review markets
# taking up to ~72 hours. Past 7 days something is genuinely wrong (voided
# market, account issue, etc.) and retrying every run is just noise.
SETTLEMENT_GIVEUP_DAYS = 7


class Database:
    def __init__(self, config: Config):
        self.client: Client = create_client(
            config.supabase_url, config.supabase_service_key
        )
        log.info("Database client initialized")

    # ── Daily budget tracking ──────────────────────────────────────────────────

    def get_todays_spend(self) -> float:
        """Sum of order_price_dollars for all orders placed today (UTC)."""
        today_iso = datetime.now(timezone.utc).date().isoformat()
        result = (
            self.client.table("orders")
            .select("order_price_dollars")
            .gte("created_at", today_iso)
            .execute()
        )
        if result.data:
            return sum(float(r.get("order_price_dollars") or 0) for r in result.data)
        return 0.0

    def get_todays_tickers(self) -> set:
        """Return the set of tickers already ordered today (prevents duplicates)."""
        today_iso = datetime.now(timezone.utc).date().isoformat()
        result = (
            self.client.table("orders")
            .select("ticker")
            .gte("created_at", today_iso)
            .execute()
        )
        return {r["ticker"] for r in (result.data or [])}

    # ── Run records ────────────────────────────────────────────────────────────

    def insert_run(self, run_data: dict) -> str:
        """Insert a new run record and return its UUID."""
        result = self.client.table("runs").insert(run_data).execute()
        run_id = result.data[0]["id"]
        log.info(f"Run record created: {run_id}")
        return run_id

    def update_run(self, run_id: str, updates: dict):
        self.client.table("runs").update(updates).eq("id", run_id).execute()

    # ── Order records ──────────────────────────────────────────────────────────

    def insert_order(self, order_data: dict) -> str:
        """Insert a placed order and return its UUID."""
        result = self.client.table("orders").insert(order_data).execute()
        return result.data[0]["id"]

    # ── Settlement ─────────────────────────────────────────────────────────────

    def get_unsettled_orders(self) -> list[dict]:
        """
        Orders that have passed their close_time but haven't received a
        settlement_result yet — AND closed within the last
        SETTLEMENT_GIVEUP_DAYS days. Anything older is handled by
        get_stale_unsettled_orders() to prevent infinite retry.
        """
        now = datetime.now(timezone.utc)
        cutoff_iso = (now - timedelta(days=SETTLEMENT_GIVEUP_DAYS)).isoformat()
        result = (
            self.client.table("orders")
            .select("*")
            .is_("settlement_result", "null")
            .lt("close_time", now.isoformat())
            .gte("close_time", cutoff_iso)
            .execute()
        )
        return result.data or []

    def get_stale_unsettled_orders(self) -> list[dict]:
        """
        Orders past the giveup threshold (close_time more than
        SETTLEMENT_GIVEUP_DAYS ago) that still have no settlement_result.
        These are zombies — Kalshi never resolved them and probably never will.
        """
        cutoff_iso = (
            datetime.now(timezone.utc) - timedelta(days=SETTLEMENT_GIVEUP_DAYS)
        ).isoformat()
        result = (
            self.client.table("orders")
            .select("*")
            .is_("settlement_result", "null")
            .lt("close_time", cutoff_iso)
            .execute()
        )
        return result.data or []

    def mark_order_cancelled(self, order_id: str):
        """
        Mark an order that expired without filling.
        P&L is zero — no money was spent, no position was opened.
        """
        self.client.table("orders").update(
            {
                "status": "cancelled",
                "settlement_result": "cancelled",
                "payout_dollars": 0.0,
                "pnl_dollars": 0.0,
                "settled_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", order_id).execute()
        log.info(f"Order {order_id} marked cancelled (expired unfilled — pnl=$0.00)")

    def mark_order_unknown(self, order_id: str):
        """
        Stop trying to settle an order that's too old to bother with.
        We don't know what happened to it — Kalshi never resolved it.
        P&L is recorded as 0 (best guess: order never actually filled,
        but we can't be certain). Distinct from 'cancelled' so we can
        spot these later if they start piling up.
        """
        self.client.table("orders").update(
            {
                "status": "unknown",
                "settlement_result": "unknown",
                "payout_dollars": 0.0,
                "pnl_dollars": 0.0,
                "settled_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", order_id).execute()
        log.warning(
            f"Order {order_id} marked unknown "
            f"(>{SETTLEMENT_GIVEUP_DAYS}d past close — giving up)"
        )

    def update_settlement(
        self,
        order_id: str,
        result: str,
        payout_dollars: float,
        pnl_dollars: float,
    ):
        self.client.table("orders").update(
            {
                "settlement_result": result,
                "payout_dollars": payout_dollars,
                "pnl_dollars": pnl_dollars,
                "settled_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", order_id).execute()
        log.info(
            f"Order {order_id} settled: {result.upper()} | "
            f"payout=${payout_dollars:.4f} | pnl=${pnl_dollars:+.4f}"
        )
