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
        """
        Sum order_price_dollars for all orders placed today (UTC).

        Uses order_price_dollars rather than fill_cost_dollars intentionally:
        at placement time we don't know the fill cost yet, and we want to
        reserve budget conservatively based on what we committed to pay.
        """
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
        """
        Fetch orders that have closed but not yet been settled.

        Bounded by the giveup window — orders older than SETTLEMENT_GIVEUP_DAYS
        past close are handled by get_stale_unsettled_orders instead.
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
        Fetch orders that are past the giveup threshold with no settlement.
        These will be marked unknown — we've given up trying to settle them.
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
        Mark an order as cancelled — it expired without filling.

        Used when Kalshi confirms the order is cancelled/expired, or when
        a resting order is still sitting in the book after market close.
        All financial fields are zeroed — no money changed hands.
        """
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
        """
        Mark an order as unknown — past the giveup threshold with no resolution.

        This is a last resort. The stale cleanup runs before each settlement
        check. Once marked unknown, the order is excluded from future checks.
        """
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
        mark_executed: bool = False,
    ):
        """
        Record the final settlement outcome for a filled order.

        Args:
            order_id:          Supabase row ID
            result:            'yes' or 'no' — the market resolution
            payout_dollars:    Dollar amount paid out ($1.00 per contract if yes)
            pnl_dollars:       Gross P&L before fees (payout - fill_cost)
            fees_dollars:      Total fees charged by Kalshi
            fill_cost_dollars: Actual total cost of the fill (may differ from
                               limit price if partially filled at better prices)
            filled_count:      Actual number of contracts filled
            mark_executed:     If True, also updates status to 'executed'.
                               Pass True when settling via the Kalshi settlements
                               endpoint, which confirms the order was filled.
                               This is critical for orders that were initially
                               recorded as 'resting' — without this, a filled
                               resting order keeps status='resting' forever,
                               contaminating fill rate and P&L metrics.
        """
        update_data: dict = {
            "settlement_result": result,
            "payout_dollars":    payout_dollars,
            "pnl_dollars":       pnl_dollars,
            "fees_dollars":      fees_dollars,
            "settled_at":        datetime.now(timezone.utc).isoformat(),
        }

        if fill_cost_dollars is not None:
            update_data["fill_cost_dollars"] = fill_cost_dollars
        if filled_count is not None:
            update_data["filled_count"] = filled_count

        # Confirm fill status when we have ground-truth evidence the order
        # was filled. Keeps status accurate for reporting and metrics.
        if mark_executed:
            update_data["status"] = "executed"

        self.client.table("orders").update(update_data).eq("id", order_id).execute()

        net_pnl = pnl_dollars - fees_dollars
        log.info(
            f"Order {order_id} settled: {result.upper()} | "
            f"payout=${payout_dollars:.4f} | gross_pnl=${pnl_dollars:+.4f} | "
            f"fees=${fees_dollars:.4f} | net_pnl=${net_pnl:+.4f}"
            + (" [status→executed]" if mark_executed else "")
        )