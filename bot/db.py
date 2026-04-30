import logging
from datetime import datetime, timezone, timedelta
from supabase import create_client, Client
from config import Config

log = logging.getLogger(__name__)

# After this many days past close_time with no settlement, give up trying.
SETTLEMENT_GIVEUP_DAYS = 7


class Database:
    def __init__(self, config: Config):
        self.client: Client = create_client(
            config.supabase_url, config.supabase_service_key
        )
        log.info("Database client initialized")

    # ── Bot configuration ─────────────────────────────────────────────────────

    def is_trading_enabled(self) -> bool:
        """
        Read the kill switch from bot_config.

        Defaults to True (enabled) if the row is missing or unreadable.
        Fail-safe direction: a misconfigured config table shouldn't silently
        stop a $10/day trading bot. If you want to disable, do it deliberately.
        """
        try:
            result = (
                self.client.table("bot_config")
                .select("value")
                .eq("key", "trading_enabled")
                .execute()
            )
            if not result.data:
                log.warning(
                    "bot_config has no 'trading_enabled' row — defaulting to enabled"
                )
                return True
            return result.data[0]["value"].lower() == "true"
        except Exception as e:
            log.warning(
                f"Could not read bot_config ({e}) — defaulting to enabled"
            )
            return True

    # ── Daily budget tracking ─────────────────────────────────────────────────

    def get_todays_spend(self) -> float:
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
        today_iso = datetime.now(timezone.utc).date().isoformat()
        result = (
            self.client.table("orders")
            .select("ticker")
            .gte("created_at", today_iso)
            .execute()
        )
        return {r["ticker"] for r in (result.data or [])}

    # ── Run records ───────────────────────────────────────────────────────────

    def insert_run(self, run_data: dict) -> str:
        result = self.client.table("runs").insert(run_data).execute()
        run_id = result.data[0]["id"]
        log.info(f"Run record created: {run_id}")
        return run_id

    def update_run(self, run_id: str, updates: dict):
        self.client.table("runs").update(updates).eq("id", run_id).execute()

    # ── Order records ─────────────────────────────────────────────────────────

    def insert_order(self, order_data: dict) -> str:
        result = self.client.table("orders").insert(order_data).execute()
        return result.data[0]["id"]

    # ── Settlement ────────────────────────────────────────────────────────────

    def get_unsettled_orders(self) -> list[dict]:
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
        self.client.table("orders").update(
            {
                "status": "cancelled",
                "settlement_result": "cancelled",
                "payout_dollars": 0.0,
                "pnl_dollars": 0.0,
                "fees_dollars": 0.0,
                "fill_cost_dollars": 0.0,
                "filled_count": 0,
                "settled_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", order_id).execute()
        log.info(f"Order {order_id} marked cancelled (expired unfilled — pnl=$0.00)")

    def mark_order_unknown(self, order_id: str):
        self.client.table("orders").update(
            {
                "status": "unknown",
                "settlement_result": "unknown",
                "payout_dollars": 0.0,
                "pnl_dollars": 0.0,
                "fees_dollars": 0.0,
                "fill_cost_dollars": 0.0,
                "filled_count": 0,
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
        fees_dollars: float = 0.0,
        fill_cost_dollars: float | None = None,
        filled_count: int | None = None,
    ):
        update_data = {
            "settlement_result": result,
            "payout_dollars": payout_dollars,
            "pnl_dollars": pnl_dollars,
            "fees_dollars": fees_dollars,
            "settled_at": datetime.now(timezone.utc).isoformat(),
        }
        if fill_cost_dollars is not None:
            update_data["fill_cost_dollars"] = fill_cost_dollars
        if filled_count is not None:
            update_data["filled_count"] = filled_count

        self.client.table("orders").update(update_data).eq("id", order_id).execute()

        net_pnl = pnl_dollars - fees_dollars
        log.info(
            f"Order {order_id} settled: {result.upper()} | "
            f"payout=${payout_dollars:.4f} | gross_pnl=${pnl_dollars:+.4f} | "
            f"fees=${fees_dollars:.4f} | net_pnl=${net_pnl:+.4f}"
        )