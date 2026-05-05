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
import { kalshiGet } from "@/lib/kalshi-server";

// ── Types ────────────────────────────────────────────────────────────────────

interface PositionsResponse {
  market_positions?: unknown[];
}

interface BalanceResponse {
  balance?: number;
  portfolio_value?: number;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // Fire both requests in parallel — they're independent
    const [positionsData, balanceData] = await Promise.all([
      kalshiGet("/trade-api/v2/portfolio/positions", {
        limit: "250",
        settlement_status: "unsettled",
      }) as Promise<PositionsResponse>,
      kalshiGet("/trade-api/v2/portfolio/balance") as Promise<BalanceResponse>,
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