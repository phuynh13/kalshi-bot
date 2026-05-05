import time
import base64
import logging
import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
from config import Config

log = logging.getLogger(__name__)


class KalshiClient:
    def __init__(self, config: Config):
        self.config = config
        with open(config.private_key_path, "rb") as f:
            self.private_key = serialization.load_pem_private_key(
                f.read(), password=None
            )
        self.http = httpx.Client(timeout=30)
        log.info(
            f"KalshiClient initialized — base URL: {config.base_url}"
        )

    # ── Authentication ─────────────────────────────────────────────────────────

    def _auth_headers(self, method: str, path: str) -> dict:
        """Generate RSA-PSS signed headers required by Kalshi's API."""
        timestamp = str(int(time.time() * 1000))
        message = f"{timestamp}{method}{path}".encode()
        signature = self.private_key.sign(
            message,
            asym_padding.PSS(
                mgf=asym_padding.MGF1(hashes.SHA256()),
                salt_length=asym_padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return {
            "Content-Type": "application/json",
            "KALSHI-ACCESS-KEY": self.config.api_key_id,
            "KALSHI-ACCESS-TIMESTAMP": timestamp,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode(),
        }

    # ── Market data ───────────────────────────────────────────────────────────

    def get_markets(
        self,
        max_close_ts: int,
        min_close_ts: int | None = None,
        status: str = "open",
        page_size: int = 1000,
    ) -> list[dict]:
        path = "/trade-api/v2/markets"
        markets: list[dict] = []
        cursor: str | None = None

        while True:
            params: dict = {
                "status": status,
                "max_close_ts": max_close_ts,
                "limit": page_size,
            }
            if min_close_ts:
                params["min_close_ts"] = min_close_ts
            if cursor:
                params["cursor"] = cursor

            resp = self.http.get(
                f"{self.config.base_url}{path}",
                headers=self._auth_headers("GET", path),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("markets", [])
            markets.extend(batch)
            cursor = data.get("cursor")
            log.debug(f"Fetched {len(batch)} markets (total so far: {len(markets)})")
            if not cursor:
                break

        return markets

    def get_events(
        self,
        max_close_ts: int,
        min_close_ts: int | None = None,
        status: str = "open",
        page_size: int = 200,
    ) -> list[dict]:
        """
        Fetch events for the same time window used to fetch markets.

        Why: Kalshi's market objects do not include a 'category' field.
        Category is on the parent event object. This method is called once
        per run to build a lookup of event_ticker → category.
        """
        path = "/trade-api/v2/events"
        events: list[dict] = []
        cursor: str | None = None

        while True:
            params: dict = {
                "status": status,
                "limit": page_size,
            }
            if min_close_ts:
                params["min_close_ts"] = min_close_ts
            if max_close_ts:
                params["max_close_ts"] = max_close_ts
            if cursor:
                params["cursor"] = cursor

            resp = self.http.get(
                f"{self.config.base_url}{path}",
                headers=self._auth_headers("GET", path),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("events", [])
            events.extend(batch)
            cursor = data.get("cursor")
            log.debug(f"Fetched {len(batch)} events (total so far: {len(events)})")
            if not cursor:
                break

        return events

    def get_settlements(self, limit: int = 500) -> list[dict]:
        """
        Fetch recent settled positions from the portfolio settlements endpoint.

        This is the ground truth for whether an order was filled and paid out.
        Use this instead of the /portfolio/orders/{id} endpoint for settlement
        processing — Kalshi archives completed orders (returning 404) but
        settlements remain accessible here indefinitely.

        Kalshi field names (confirmed via API):
          ticker                  — market ticker
          market_result           — "yes" or "no"
          yes_count_fp            — string, e.g. "1.00" (contracts held on YES side)
          yes_total_cost_dollars  — string, e.g. "0.660000" (total cost paid, in dollars)
          fee_cost                — string, e.g. "0.020000" (fees paid, in dollars)
          revenue                 — integer, in CENTS (100 = $1.00 payout)
          settled_time            — ISO timestamp

        Note: revenue is in cents while cost fields are in dollars. Intentional
        Kalshi inconsistency — divide revenue by 100 to get dollars.

        Returns settlements newest-first. Paginates until `limit` is reached
        or all records are exhausted.
        """
        path = "/trade-api/v2/portfolio/settlements"
        settlements: list[dict] = []
        cursor: str | None = None

        while len(settlements) < limit:
            params: dict = {"limit": min(200, limit - len(settlements))}
            if cursor:
                params["cursor"] = cursor

            resp = self.http.get(
                f"{self.config.base_url}{path}",
                headers=self._auth_headers("GET", path),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("settlements", [])
            settlements.extend(batch)
            cursor = data.get("cursor")
            log.debug(
                f"Fetched {len(batch)} settlements "
                f"(total so far: {len(settlements)})"
            )
            if not cursor or not batch:
                break

        return settlements

    def get_order(self, order_id: str) -> dict:
        """
        Fetch a single order by Kalshi order ID.

        Note: Kalshi archives orders after settlement. Calling this on a
        settled order returns 404. Use get_settlements() for ground-truth
        settlement data instead. This method is still useful for checking
        the status of resting/active orders (e.g. was it cancelled?).
        """
        path = f"/trade-api/v2/portfolio/orders/{order_id}"
        resp = self.http.get(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("GET", path),
        )
        resp.raise_for_status()
        return resp.json().get("order", {})

    def get_market(self, ticker: str) -> dict:
        path = f"/trade-api/v2/markets/{ticker}"
        resp = self.http.get(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("GET", path),
        )
        resp.raise_for_status()
        return resp.json().get("market", {})

    # ── Portfolio data ────────────────────────────────────────────────────────

    def get_positions(self) -> list[dict]:
        """
        Fetch all current open positions on the account.

        Kalshi field names (confirmed via debug):
          position_fp              — string, net contract count e.g. "1.00"
                                     "0.00" = resting order, not yet filled
          market_exposure_dollars  — string, cost basis in dollars
          realized_pnl_dollars     — string, in dollars
          fees_paid_dollars        — string, in dollars
          resting_orders_count     — integer
        """
        path = "/trade-api/v2/portfolio/positions"
        params = {"limit": 250, "settlement_status": "unsettled"}
        resp = self.http.get(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("GET", path),
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("market_positions", [])

    def get_balance(self) -> dict:
        """
        Fetch account balance and portfolio value.

        Returns:
            { "balance": <cents int>, "portfolio_value": <cents int>, ... }
        """
        path = "/trade-api/v2/portfolio/balance"
        resp = self.http.get(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("GET", path),
        )
        resp.raise_for_status()
        return resp.json()

    # ── Order placement ───────────────────────────────────────────────────────

    def place_limit_order(
        self, ticker: str, yes_price_cents: int, count: int = 1
    ) -> dict:
        path = "/trade-api/v2/portfolio/orders"
        body = {
            "ticker": ticker,
            "action": "buy",
            "side": "yes",
            "type": "limit",
            "count": count,
            "yes_price": yes_price_cents,
        }
        log.debug(f"Placing order: {body}")
        resp = self.http.post(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("POST", path),
            json=body,
        )
        resp.raise_for_status()
        return resp.json().get("order", {})

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def close(self):
        self.http.close()