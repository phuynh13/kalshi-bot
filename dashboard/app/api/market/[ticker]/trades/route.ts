// app/api/market/[ticker]/trades/route.ts
//
// Returns recent completed trades for a single market.
//
// Called by the market detail page at /market/[ticker].
// Never called from the browser directly — this is a server-side proxy.
//
// Kalshi endpoint:
//   GET /trade-api/v2/markets/{ticker}/trades
//
// Query params used:
//   limit — how many recent trades to return (we default to 50)
//
// Returns:
//   {
//     ok: true,
//     ticker: "...",
//     trades: [
//       {
//         trade_id: "...",
//         ticker: "...",
//         yes_price:  63,          ← price in cents the YES side paid
//         no_price:   37,          ← yes_price + no_price always = 100
//         count:      5,           ← contracts that changed hands
//         taker_side: "yes",       ← which side was the aggressor (market order)
//         created_time: "..."      ← ISO timestamp
//       },
//       ...
//     ]
//   }
//
// The taker_side field tells you who drove the trade.
// "yes" taker = someone was actively buying YES (bullish pressure)
// "no" taker  = someone was actively buying NO (bearish pressure)
// This is directional signal — the spread alone can't give you this.

import { NextResponse } from "next/server";
import { kalshiGet } from "@/lib/kalshi-server";

export async function GET(
  request: Request,
  { params }: { params: { ticker: string } }
) {
  const { ticker } = params;

  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "Missing ticker" },
      { status: 400 }
    );
  }

  // Allow the caller to request more trades via ?limit=N, cap at 100
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(rawLimit, 1), 100).toString();

  try {
    const path = `/trade-api/v2/markets/${ticker}/trades`;
    const data = await kalshiGet(path, { limit }) as { trades?: unknown[] };

    return NextResponse.json({
      ok: true,
      ticker,
      trades: data.trades ?? [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}