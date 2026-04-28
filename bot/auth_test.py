"""
auth_test.py — Run this to diagnose Kalshi authentication issues.
Usage: python3.10 auth_test.py

Tests the simplest authenticated endpoint (/portfolio/balance) using the
SAME config the bot uses, so DEMO_MODE, base URL, API key ID, and private
key path all match production behavior. Prints exactly what is being signed
so you can verify it's correct if the request fails.
"""

import time
import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
import httpx

from config import Config
from kalshi_client import KalshiClient

print("=== Kalshi Auth Diagnostic ===\n")

# ── Load config (same loader the bot uses — guarantees parity) ────────────────
try:
    config = Config()
except Exception as e:
    print(f"ERROR loading config: {e}")
    raise SystemExit(1)

mode_label = "DEMO" if config.demo_mode else "LIVE"

print(f"Mode       : {mode_label}")
print(f"Base URL   : {config.base_url}")
print(f"API Key ID : {config.api_key_id!r}")
print(f"Key file   : {config.private_key_path}")
print(f"Key exists : {os.path.exists(config.private_key_path)}\n")

# ── Load private key via the same client the bot uses ─────────────────────────
# This catches any key-format issues in the same code path bot.py would hit.
try:
    client = KalshiClient(config)
    private_key = client.private_key
    print(f"Key type   : {type(private_key).__name__}")
    print(f"Key size   : {private_key.key_size} bits\n")
except Exception as e:
    print(f"ERROR loading key: {e}")
    raise SystemExit(1)

# ── Build and sign a request ──────────────────────────────────────────────────
path      = "/trade-api/v2/portfolio/balance"
method    = "GET"
timestamp = str(int(time.time() * 1000))
message   = f"{timestamp}{method}{path}".encode("utf-8")

print(f"Timestamp  : {timestamp}")
print(f"Method     : {method}")
print(f"Path       : {path}")
print(f"Message    : {message.decode()!r}\n")

try:
    signature = private_key.sign(
        message,
        asym_padding.PSS(
            mgf=asym_padding.MGF1(hashes.SHA256()),
            salt_length=asym_padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    sig_b64 = base64.b64encode(signature).decode()
    print(f"Signature  : {sig_b64[:40]}...  ({len(sig_b64)} chars)\n")
except Exception as e:
    print(f"ERROR signing: {e}")
    raise SystemExit(1)

# ── Make the request ──────────────────────────────────────────────────────────
headers = {
    "Content-Type":            "application/json",
    "KALSHI-ACCESS-KEY":       config.api_key_id,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": sig_b64,
}

url = f"{config.base_url}{path}"
print(f"Calling: GET {url}")

try:
    resp = httpx.get(url, headers=headers, timeout=30)
    print(f"Status : {resp.status_code}")
    print(f"Body   : {resp.text[:300]}")

    if resp.status_code == 200:
        print(f"\n✓ Auth OK against {mode_label} environment.")
    else:
        print(f"\n✗ Auth FAILED against {mode_label} environment.")
        print("  Common causes:")
        print("    • Wrong DEMO_MODE — demo keys won't work in prod, vice versa")
        print("    • Key file doesn't match the API key ID")
        print("    • Key was created for a different Kalshi account")
        print("    • Server clock drift (timestamp must be within ~5s of server time)")
except Exception as e:
    print(f"ERROR making request: {e}")
    raise SystemExit(1)
finally:
    client.close()
