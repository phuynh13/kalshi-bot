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

        Why this exists: Kalshi's market objects do not include a 'category'
        field. The field audit confirmed this — 'category' is simply not in
        the market endpoint response. Category lives on the parent event object.

        This method is called once per run by build_category_lookup() in bot.py,
        which returns a dict of event_ticker -> category for attaching to orders.

        Each event dict includes at minimum:
          - event_ticker (str)
          - category (str): e.g. "Finance", "Economics", "Climate and Weather"
          - title (str)
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

    def get_order(self, order_id: str) -> dict:
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
          - position_fp (str): net contract count as decimal string e.g. "1.00"
                               Positive = YES side. "0.00" = resting order, not filled.
          - market_exposure_dollars (str): cost basis already in dollars e.g. "0.660000"
          - realized_pnl_dollars (str): realized P&L in dollars
          - fees_paid_dollars (str): fees in dollars
          - resting_orders_count (int): number of unfilled resting orders on this market

        Filter on parseFloat(position_fp) !== 0 to exclude resting-only positions.
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