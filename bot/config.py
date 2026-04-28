import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    def __init__(self):
        # ── Environment ────────────────────────────────────────────────────────
        self.demo_mode: bool = os.getenv("DEMO_MODE", "true").lower() == "true"
        self.base_url: str = (
            "https://demo-api.kalshi.co"
            if self.demo_mode
            else "https://api.elections.kalshi.com"
        )

        # ── Kalshi credentials ─────────────────────────────────────────────────
        self.api_key_id: str = os.getenv("KALSHI_API_KEY_ID", "")
        self.private_key_path: str = os.getenv(
            "KALSHI_PRIVATE_KEY_PATH", "kalshi_private_key.pem"
        )
        if not self.api_key_id:
            raise ValueError("KALSHI_API_KEY_ID environment variable is required")

        # ── Strategy parameters ────────────────────────────────────────────────
        # Maximum total dollars to spend across all orders in a single day
        self.daily_spend_limit: float = float(os.getenv("DAILY_SPEND_LIMIT", "10.00"))

        # Implied probability range for YES contracts to qualify
        self.min_probability: float = float(os.getenv("MIN_PROBABILITY", "0.58"))
        self.max_probability: float = float(os.getenv("MAX_PROBABILITY", "0.85"))

        # Fixed contract count per order
        self.contracts_per_order: int = int(os.getenv("CONTRACTS_PER_ORDER", "1"))

        # Minimum 24h volume (contracts). Filters stale/illiquid markets.
        self.min_volume_24h: float = float(os.getenv("MIN_VOLUME_24H", "50"))

        # Maximum allowed bid-ask spread in dollars (e.g. 0.10 = 10 cents)
        self.max_spread: float = float(os.getenv("MAX_SPREAD", "0.10"))

        # Only consider markets closing within this many hours from now
        self.hours_to_close: int = int(os.getenv("HOURS_TO_CLOSE", "24"))

        # ── Category exclusions ────────────────────────────────────────────────
        # Comma-separated list of Kalshi category strings to skip.
        # Known Kalshi categories (uncomment or add to EXCLUDED_CATEGORIES in .env):
        #   Economics, Politics, Sports, Climate and Weather, Finance,
        #   Technology, Entertainment, Pop Culture, Crypto, Health,
        #   Geopolitics, Awards, Science
        excluded_raw: str = os.getenv("EXCLUDED_CATEGORIES", "")
        self.excluded_categories: set = (
            {c.strip() for c in excluded_raw.split(",") if c.strip()}
            if excluded_raw
            else set()
        )

        # ── Supabase ───────────────────────────────────────────────────────────
        self.supabase_url: str = os.getenv("SUPABASE_URL", "")
        self.supabase_service_key: str = os.getenv("SUPABASE_SERVICE_KEY", "")
        if not self.supabase_url or not self.supabase_service_key:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required"
            )