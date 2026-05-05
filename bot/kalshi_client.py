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

        Each position represents holdings in a single market. Includes:
          - ticker, market_exposure (cost basis in cents), position (count of contracts)
          - realized_pnl, fees_paid (cents)
          - last_updated_ts

        Position counts are positive for YES side, negative for NO side.
        Since this bot only buys YES, all positions should be positive.

        Note: this returns positions whose markets haven't yet settled. Once
        a market resolves, its position drops off this list and shows up on
        /portfolio/settlements instead.
        """
        path = "/trade-api/v2/portfolio/positions"
        # Get up to 250 positions (Kalshi's default limit). For our $30/day bot
        # we'll never have more than ~50 open at once, so no pagination needed.
        params = {"limit": 250, "settlement_status": "unsettled"}
        resp = self.http.get(
            f"{self.config.base_url}{path}",
            headers=self._auth_headers("GET", path),
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()
        # Response has both market_positions (per-market) and event_positions.
        # We want market_positions for individual ticker-level exposure.
        return data.get("market_positions", [])

    def get_balance(self) -> dict:
        """
        Fetch account balance and portfolio value.

        Returns:
            { "balance": <cents>, "portfolio_value": <cents>, "updated_ts": <unix> }
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