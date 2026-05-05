// dashboard/app/api/positions/route.ts
//
// Fetches live position data + balance from Kalshi. Runs server-side so the
// API key + private key never leave the server. Browser calls /api/positions
// which calls Kalshi which returns positions. Browser sees positions only.
//
// Vercel env vars required:
//   KALSHI_API_KEY_ID         — your Kalshi access key ID (UUID)
//   KALSHI_PRIVATE_KEY_PEM    — full PEM string contents (multi-line)
//
// Returns:
//   { ok: true, positions: [...], balance: {...} }
//   { ok: false, error: "..." }

import { NextResponse } from "next/server";
import crypto from "crypto";

// Production Kalshi base URL (the bot uses LIVE mode)
const BASE_URL = "https://api.elections.kalshi.com";

const API_KEY_ID = process.env.KALSHI_API_KEY_ID!;
const PRIVATE_KEY_PEM = process.env.KALSHI_PRIVATE_KEY_PEM!;

// ── Auth headers (RSA-PSS / SHA256, matches the Python client) ──────────────

function buildAuthHeaders(method: string, path: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  signer.end();

  const signature = signer
    .sign({
      key: PRIVATE_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

async function kalshiGet(path: string, params?: Record<string, string>) {
  const url = new URL(BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  // Note: Kalshi signs the path *without* query string
  const headers = buildAuthHeaders("GET", path);

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kalshi ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET() {
  if (!API_KEY_ID || !PRIVATE_KEY_PEM) {
    return NextResponse.json(
      { ok: false, error: "Server configuration missing (KALSHI_*)" },
      { status: 500 }
    );
  }

  try {
    // Fire both requests in parallel — they're independent
    const [positionsData, balanceData] = await Promise.all([
      kalshiGet("/trade-api/v2/portfolio/positions", {
        limit: "250",
        settlement_status: "unsettled",
      }),
      kalshiGet("/trade-api/v2/portfolio/balance"),
    ]);

    return NextResponse.json({
      ok: true,
      positions: positionsData.market_positions ?? [],
      balance: balanceData,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}