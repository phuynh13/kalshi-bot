"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { supabase, Order, DailyPnl, LifetimeStats } from "../lib/supabase";

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmt = {
  dollars: (v: number | null | undefined) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`,
  pct: (v: number | null | undefined) =>
    v == null ? "—" : `${v.toFixed(1)}%`,
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
    }),
};

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color = "text-white",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

// ── Settlement Badge ──────────────────────────────────────────────────────────

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

// ── P&L Chart ────────────────────────────────────────────────────────────────

function PnLChart({ data }: { data: DailyPnl[] }) {
  // Build cumulative P&L series (ascending by date)
  const sorted = [...data].sort((a, b) =>
    a.trade_date.localeCompare(b.trade_date)
  );
  let cumulative = 0;
  const chartData = sorted.map((d) => {
    cumulative += Number(d.realized_pnl);
    return {
      date: d.trade_date,
      cumulative: parseFloat(cumulative.toFixed(4)),
      daily: parseFloat(Number(d.realized_pnl).toFixed(4)),
    };
  });

  const isPositive = cumulative >= 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-400 mb-4">
        Cumulative P&amp;L
      </h2>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={isPositive ? "#10b981" : "#ef4444"}
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor={isPositive ? "#10b981" : "#ef4444"}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            tick={{ fill: "#6b7280", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: "#6b7280", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `$${v.toFixed(2)}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
              fontSize: "12px",
            }}
            formatter={(v: number) => [`$${v.toFixed(4)}`, ""]}
          />
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke={isPositive ? "#10b981" : "#ef4444"}
            strokeWidth={2}
            fill="url(#pnlGradient)"
            name="Cumulative P&L"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Orders Table ──────────────────────────────────────────────────────────────

function OrdersTable({ orders }: { orders: Order[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-400">All Orders</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {[
                "Date",
                "Market",
                "Category",
                "Entry",
                "Midpoint",
                "Spread",
                "Result",
                "P&L",
              ].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {orders.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-gray-500"
                >
                  No orders yet.
                </td>
              </tr>
            )}
            {orders.map((o) => {
              const spread =
                o.yes_ask_dollars && o.yes_bid_dollars
                  ? (o.yes_ask_dollars - o.yes_bid_dollars).toFixed(3)
                  : "—";
              const pnlColor =
                o.pnl_dollars == null
                  ? "text-gray-400"
                  : o.pnl_dollars >= 0
                  ? "text-emerald-400"
                  : "text-red-400";
              return (
                <tr key={o.id} className="hover:bg-gray-800/40 transition">
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    <div>{fmt.date(o.created_at)}</div>
                    <div className="text-xs text-gray-600">
                      {fmt.time(o.created_at)}
                    </div>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <div
                      className="font-mono text-xs text-indigo-400 truncate"
                      title={o.ticker}
                    >
                      {o.ticker}
                    </div>
                    <div
                      className="text-xs text-gray-400 truncate"
                      title={o.market_title}
                    >
                      {o.market_title || "—"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {o.category || "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-300 whitespace-nowrap">
                    ${o.order_price_dollars?.toFixed(2) ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-400 text-xs whitespace-nowrap">
                    ${o.midpoint_dollars?.toFixed(4) ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">
                    {spread !== "—" ? `$${spread}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <ResultBadge result={o.settlement_result} />
                  </td>
                  <td className={`px-4 py-3 font-mono font-medium ${pnlColor}`}>
                    {fmt.dollars(o.pnl_dollars)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [stats, setStats] = useState<LifetimeStats | null>(null);
  const [dailyPnl, setDailyPnl] = useState<DailyPnl[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  async function load() {
    setLoading(true);
    const [statsRes, dailyRes, ordersRes] = await Promise.all([
      supabase.from("lifetime_stats").select("*").single(),
      supabase
        .from("daily_pnl")
        .select("*")
        .order("trade_date", { ascending: false })
        .limit(30),
      supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (statsRes.data) setStats(statsRes.data);
    if (dailyRes.data) setDailyPnl(dailyRes.data);
    if (ordersRes.data) setOrders(ordersRes.data);
    setLastUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const pnlColor =
    !stats || stats.total_pnl == null
      ? "text-white"
      : stats.total_pnl >= 0
      ? "text-emerald-400"
      : "text-red-400";

  return (
    <div className="min-h-screen px-4 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            Kalshi Bot Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Automated YES limit orders · 58–85% probability range
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg px-3 py-1.5 transition disabled:opacity-40"
        >
          {loading ? "Loading…" : `Refresh · ${lastUpdated}`}
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total Orders"
          value={stats?.total_orders?.toString() ?? "—"}
          sub={`${stats?.settled_orders ?? 0} settled · ${
            stats?.cancelled_orders ?? 0
          } expired · ${stats?.pending_orders ?? 0} pending`}
        />
        <StatCard
          label="Win Rate"
          value={fmt.pct(stats?.win_rate_pct)}
          sub={`${stats?.total_wins ?? 0}W / ${stats?.total_losses ?? 0}L`}
          color={
            stats?.win_rate_pct == null
              ? "text-white"
              : stats.win_rate_pct >= 58
              ? "text-emerald-400"
              : "text-red-400"
          }
        />
        <StatCard
          label="Total P&L"
          value={fmt.dollars(stats?.total_pnl)}
          sub={`Spent: $${stats?.total_spent?.toFixed(2) ?? "0.00"}`}
          color={pnlColor}
        />
        <StatCard
          label="Avg Entry Price"
          value={
            stats?.avg_entry_price != null
              ? `$${stats.avg_entry_price.toFixed(3)}`
              : "—"
          }
          sub="Per settled contract"
        />
      </div>

      {/* P&L Chart */}
      {dailyPnl.length > 0 && (
        <div className="mb-6">
          <PnLChart data={dailyPnl} />
        </div>
      )}

      {/* Orders Table */}
      <OrdersTable orders={orders} />

      <p className="text-center text-xs text-gray-700 mt-6">
        kalshi.webreads.org · data via Supabase
      </p>
    </div>
  );
}
