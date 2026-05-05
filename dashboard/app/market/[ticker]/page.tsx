"use client";

// app/market/[ticker]/page.tsx
//
// Market detail page — drill-down view for a single market ticker.
//
// Shows three layers of information:
//   1. Bot order record (from Supabase) — what your bot did on this market
//   2. Live orderbook (from Kalshi) — current bid/ask depth ladder
//   3. Recent trades (from Kalshi) — last 50 completed transactions
//
// Accessed by clicking any ticker link in the main dashboard.
// URL format: /market/KXBRENTD-26MAY0517-T111

import { useEffect, useState } from "react";
import { supabase, Order } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderbookLevel {
  price_cents: number;
  quantity: number;
}

interface Orderbook {
  yes: number[][];   // [price_cents, quantity][]
  no:  number[][];
}

interface Trade {
  trade_id: string;
  ticker: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: "yes" | "no";
  count_fp: string;
  created_time: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = {
  dollars: (v: number | null | undefined) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`,
  price: (v: string | number | null | undefined) =>
    v == null ? "—" : `$${Number(v).toFixed(2)}`,
  date: (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  time: (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  count: (v: string | number) => Number(v).toFixed(2),
};

function ResultBadge({ result }: { result: string | null }) {
  if (!result)
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-400">
        Pending
      </span>
    );
  if (result === "yes")
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-emerald-900 text-emerald-300 font-medium">
        YES ✓
      </span>
    );
  if (result === "cancelled")
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-yellow-900 text-yellow-300">
        Expired unfilled
      </span>
    );
  if (result === "unknown")
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">
        Unresolved
      </span>
    );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-900 text-red-300 font-medium">
      NO ✗
    </span>
  );
}

// ── Bot Order Panel ───────────────────────────────────────────────────────────
// Anchors the page — shows what your bot actually did on this market.

function BotOrderPanel({ order }: { order: Order | null }) {
  if (!order) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 mb-6">
        <p className="text-sm text-gray-500">
          No bot order found for this ticker.
        </p>
      </div>
    );
  }

  const netPnl =
    order.pnl_dollars == null
      ? null
      : order.pnl_dollars - (order.fees_dollars ?? 0);
  const pnlColor =
    netPnl == null
      ? "text-gray-400"
      : netPnl >= 0
      ? "text-emerald-400"
      : "text-red-400";

  const filledAt =
    order.fill_cost_dollars != null && order.filled_count
      ? `$${(order.fill_cost_dollars / order.filled_count).toFixed(2)}`
      : "—";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
            Bot order
          </p>
          <p className="text-sm text-gray-300">{order.market_title || "—"}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {order.category || "—"} ·{" "}
            {order.close_time
              ? `Closes ${fmt.date(order.close_time)}`
              : "No close time"}
          </p>
        </div>
        <ResultBadge result={order.settlement_result} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-gray-500 mb-1">Limit price</p>
          <p className="text-sm font-mono text-gray-300">
            {fmt.price(order.order_price_dollars)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">Filled at</p>
          <p className="text-sm font-mono text-gray-300">{filledAt}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">Fees</p>
          <p className="text-sm font-mono text-gray-400">
            {order.fees_dollars != null
              ? `$${order.fees_dollars.toFixed(4)}`
              : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">Net P&amp;L</p>
          <p className={`text-sm font-mono font-medium ${pnlColor}`}>
            {fmt.dollars(netPnl)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Orderbook Panel ───────────────────────────────────────────────────────────
// Bid/ask depth ladder. yes[] = bids, no[] = asks (sellers of YES).

function OrderbookPanel({
  orderbook,
  loading,
  error,
  botPriceCents,
}: {
  orderbook: Orderbook | null;
  loading: boolean;
  error: string | null;
  botPriceCents: number | null;
}) {
  if (loading)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Order book
        </p>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );

  if (error)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Order book
        </p>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );

  const bids: OrderbookLevel[] = (orderbook?.yes ?? [])
    .map(([price_cents, quantity]) => ({ price_cents, quantity }))
    .sort((a, b) => b.price_cents - a.price_cents)
    .slice(0, 10);

  const asks: OrderbookLevel[] = (orderbook?.no ?? [])
    .map(([price_cents, quantity]) => ({ price_cents, quantity }))
    .sort((a, b) => a.price_cents - b.price_cents)
    .slice(0, 10);

  const isEmpty = bids.length === 0 && asks.length === 0;

  const maxQty = Math.max(
    ...bids.map((b) => b.quantity),
    ...asks.map((a) => a.quantity),
    1
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider">
          Order book
        </p>
        {botPriceCents && (
          <p className="text-xs text-gray-500">
            Bot entry:{" "}
            <span className="text-indigo-400 font-mono">
              {botPriceCents}¢
            </span>
          </p>
        )}
      </div>

      {isEmpty ? (
        <p className="text-sm text-gray-500">
          No active orders — market may be closed or illiquid.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {/* Bids — YES buyers */}
          <div>
            <p className="text-xs text-emerald-500 uppercase tracking-wider mb-2">
              Bids (YES buyers)
            </p>
            {bids.length === 0 ? (
              <p className="text-xs text-gray-600">No bids</p>
            ) : (
              <div className="space-y-1">
                {bids.map((level, i) => {
                  const isBot = botPriceCents === level.price_cents;
                  const barWidth = `${(level.quantity / maxQty) * 100}%`;
                  return (
                    <div key={i} className="relative">
                      {/* Depth bar */}
                      <div
                        className="absolute inset-y-0 left-0 bg-emerald-900/30 rounded"
                        style={{ width: barWidth }}
                      />
                      <div className="relative flex items-center justify-between px-2 py-1">
                        <span
                          className={`text-xs font-mono ${
                            isBot
                              ? "text-indigo-400 font-semibold"
                              : "text-emerald-400"
                          }`}
                        >
                          {level.price_cents}¢
                          {isBot && (
                            <span className="ml-1 text-indigo-500">← bot</span>
                          )}
                        </span>
                        <span className="text-xs font-mono text-gray-400">
                          {level.quantity}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Asks — NO buyers = YES sellers */}
          <div>
            <p className="text-xs text-red-500 uppercase tracking-wider mb-2">
              Asks (YES sellers)
            </p>
            {asks.length === 0 ? (
              <p className="text-xs text-gray-600">No asks</p>
            ) : (
              <div className="space-y-1">
                {asks.map((level, i) => {
                  const barWidth = `${(level.quantity / maxQty) * 100}%`;
                  // NO price + YES price = 100 cents
                  const yesPriceCents = 100 - level.price_cents;
                  return (
                    <div key={i} className="relative">
                      <div
                        className="absolute inset-y-0 left-0 bg-red-900/30 rounded"
                        style={{ width: barWidth }}
                      />
                      <div className="relative flex items-center justify-between px-2 py-1">
                        <span className="text-xs font-mono text-red-400">
                          {yesPriceCents}¢
                        </span>
                        <span className="text-xs font-mono text-gray-400">
                          {level.quantity}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trades Panel ──────────────────────────────────────────────────────────────
// Recent completed transactions. taker_side tells you who was the aggressor.

function TradesPanel({
  trades,
  loading,
  error,
}: {
  trades: Trade[];
  loading: boolean;
  error: string | null;
}) {
  if (loading)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Recent trades
        </p>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );

  if (error)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Recent trades
        </p>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );

  // Count directional pressure
  const yesTrades = trades.filter((t) => t.taker_side === "yes").length;
  const noTrades = trades.filter((t) => t.taker_side === "no").length;
  const totalTrades = trades.length;
  const yesPct = totalTrades > 0 ? (yesTrades / totalTrades) * 100 : 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider">
          Recent trades
        </p>
        {totalTrades > 0 && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>
              <span className="text-emerald-400 font-mono">{yesTrades}</span>{" "}
              YES aggressor
            </span>
            <span>
              <span className="text-red-400 font-mono">{noTrades}</span>{" "}
              NO aggressor
            </span>
            <span className="text-gray-600">
              ({yesPct.toFixed(0)}% bullish pressure)
            </span>
          </div>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-sm text-gray-500">No recent trades found.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {["Time", "YES price", "NO price", "Contracts", "Aggressor"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {trades.map((t) => (
                <tr key={t.trade_id} className="hover:bg-gray-800/40 transition">
                  <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {fmt.time(t.created_time)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-emerald-400">
                    {fmt.price(t.yes_price_dollars)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-red-400">
                    {fmt.price(t.no_price_dollars)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-300">
                    {fmt.count(t.count_fp)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        t.taker_side === "yes"
                          ? "bg-emerald-900/50 text-emerald-400"
                          : "bg-red-900/50 text-red-400"
                      }`}
                    >
                      {t.taker_side === "yes" ? "↑ YES" : "↓ NO"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MarketDetailPage({
  params,
}: {
  params: { ticker: string };
}) {
  const { ticker } = params;

  const [order, setOrder] = useState<Order | null>(null);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);

  const [orderbookLoading, setOrderbookLoading] = useState(true);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [orderbookError, setOrderbookError] = useState<string | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;

    // ── Supabase: fetch bot's order for this ticker ──────────────────────────
    supabase
      .from("orders")
      .select("*")
      .eq("ticker", ticker)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setOrder(data as Order);
      });

    // ── Kalshi: fetch orderbook ───────────────────────────────────────────────
    fetch(`/api/market/${ticker}/orderbook`)
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) setOrderbook(json.orderbook);
        else setOrderbookError(json.error ?? "Unknown error");
      })
      .catch((e) => setOrderbookError(e.message))
      .finally(() => setOrderbookLoading(false));

    // ── Kalshi: fetch recent trades ───────────────────────────────────────────
    fetch(`/api/market/${ticker}/trades?limit=50`)
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) setTrades(json.trades ?? []);
        else setTradesError(json.error ?? "Unknown error");
      })
      .catch((e) => setTradesError(e.message))
      .finally(() => setTradesLoading(false));
  }, [ticker]);

  // Convert bot's limit price to cents for orderbook highlighting
  const botPriceCents =
    order?.order_price_dollars != null
      ? Math.round(Number(order.order_price_dollars) * 100)
      : null;

  return (
    <div className="min-h-screen px-4 py-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <a
          href="/"
          className="text-xs text-gray-500 hover:text-gray-300 transition mb-4 inline-block"
        >
          ← Back to dashboard
        </a>
        <h1 className="text-xl font-semibold text-white font-mono">
          {ticker}
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Market detail</p>
      </div>

      {/* Bot order — anchor of the page */}
      <BotOrderPanel order={order} />

      {/* Orderbook + Trades side by side on wide screens, stacked on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <OrderbookPanel
          orderbook={orderbook}
          loading={orderbookLoading}
          error={orderbookError}
          botPriceCents={botPriceCents}
        />
        <div /> {/* spacer — trades panel below takes full width */}
      </div>

      <TradesPanel
        trades={trades}
        loading={tradesLoading}
        error={tradesError}
      />

      <p className="text-center text-xs text-gray-700 mt-6">
        kalshi.webreads.org · market detail
      </p>
    </div>
  );
}