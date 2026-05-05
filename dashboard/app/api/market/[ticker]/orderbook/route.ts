// app/api/market/[ticker]/orderbook/route.ts
//
// Returns the live order book for a single market.
//
// Called by the market detail page at /market/[ticker].
// Never called from the browser directly — this is a server-side proxy.
//
// Kalshi endpoint:
//   GET /trade-api/v2/markets/{ticker}/orderbook
//
// Returns:
//   {
//     ok: true,
//     orderbook: {
//       yes: [[price_cents, quantity], ...],  ← bids (buyers of YES)
//       no:  [[price_cents, quantity], ...],  ← asks (sellers of YES = buyers of NO)
//     }
//   }
//
// Kalshi represents the order book as two arrays:
//   yes[] — people willing to buy YES at these prices (bids)
//   no[]  — people willing to buy NO at these prices
//            (equivalent to selling YES, so this is the ask side)
//
// Prices are in cents (integer). A yes entry of [63, 12] means:
//   "12 contracts available to buy YES at 63 cents each"

import { NextResponse } from "next/server";
import { kalshiGet } from "@/lib/kalshi-server";

export async function GET(
  _request: Request,
  { params }: { params: { ticker: string } }
) {
  const { ticker } = params;

  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "Missing ticker" },
      { status: 400 }
    );
  }

  try {
    const path = `/trade-api/v2/markets/${ticker}/orderbook`;
    const data = await kalshiGet(path) as { orderbook?: unknown };

    return NextResponse.json({
      ok: true,
      ticker,
      orderbook: data.orderbook ?? { yes: [], no: [] },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}