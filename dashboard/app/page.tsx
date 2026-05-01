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
import { supabase, Order, DailyPnl, LifetimeStats, Run } from "../lib/supabase";

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
  relative: (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? "" : "s"} ago`;
  },
};

// ── Last Run Banner ──────────────────────────────────────────────────────────

const STALE_HOURS = 26;

function LastRunBanner({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-gray-500" />
          <span className="text-sm text-gray-400">No runs recorded yet</span>
        </div>
      </div>
    );
  }

  const ageHours =
    (Date.now() - new Date(run.run_at).getTime()) / (1000 * 60 * 60);
  const isStale = ageHours > STALE_HOURS;

  const dot = isStale ? "bg-red-500" : "bg-emerald-500";
  const border = isStale ? "border-red-900" : "border-emerald-900/50";
  const bg = isStale ? "bg-red-950/30" : "bg-gray-900";
  const label = isStale
    ? `⚠ Bot hasn't run in ${Math.floor(ageHours)} hours`
    : `Bot is healthy`;
  const labelColor = isStale ? "text-red-300" : "text-gray-300";

  return (
    <div
      className={`${bg} border ${border} rounded-xl px-5 py-3 mb-4 flex items-center justify-between flex-wrap gap-3`}
    >
      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className={`text-sm font-medium ${labelColor}`}>{label}</span>
        <span className="text-xs text-gray-500">
          · Last run {fmt.relative(run.run_at)}
        </span>
      </div>
      <div className="text-xs text-gray-500 flex items-center gap-4">
        <span>
          <span className="text-gray-400 font-medium">{run.orders_placed}</span>{" "}
          placed
        </span>
        <span>
          <span className="text-gray-400 font-medium">
            ${run.total_spent_dollars?.toFixed(2) ?? "0.00"}
          </span>{" "}
          spent
        </span>
        <span>{run.markets_evaluated} evaluated</span>
      </div>
    </div>
  );
}

// ── Kill Switch ──────────────────────────────────────────────────────────────

function KillSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: fetchError } = await supabase
        .from("bot_config")
        .select("value")
        .eq("key", "trading_enabled")
        .maybeSingle();

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        return;
      }
      setEnabled(data?.value?.toLowerCase() !== "false");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (enabled === null || busy) return;
    const next = !enabled;
    const action = next ? "enable" : "disable";
    if (!confirm(`Are you sure you want to ${action} trading?`)) return;

    setBusy(true);
    setError(null);
    try {
      const resp = await fetch("/api/toggle-trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      setEnabled(json.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  if (enabled === null && !error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 mb-6 flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-gray-600" />
        <span className="text-sm text-gray-500">Loading kill switch…</span>
      </div>
    );
  }

  const dot = enabled ? "bg-emerald-500" : "bg-red-500";
  const border = enabled ? "border-emerald-900/50" : "border-red-900";
  const bg = enabled ? "bg-gray-900" : "bg-red-950/30";
  const label = enabled ? "Trading enabled" : "Trading disabled";
  const labelColor = enabled ? "text-gray-300" : "text-red-300";
  const btnText = enabled ? "Disable" : "Enable";
  const btnColor = enabled
    ? "border-red-800 text-red-300 hover:bg-red-950/50"
    : "border-emerald-800 text-emerald-300 hover:bg-emerald-950/50";

  return (
    <div
      className={`${bg} border ${border} rounded-xl px-5 py-3 mb-6 flex items-center justify-between flex-wrap gap-3`}
    >
      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className={`text-sm font-medium ${labelColor}`}>{label}</span>
        {error && <span className="text-xs text-red-400">· error: {error}</span>}
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`text-xs border rounded-lg px-3 py-1.5 transition disabled:opacity-40 ${btnColor}`}
      >
        {busy ? "Working…" : btnText}
      </button>
    </div>
  );
}

// ── Run Funnel Breakdown ─────────────────────────────────────────────────────
// Shows the full pipeline: markets evaluated → qualified → placed.
// Click to expand for rejection reasons + placement-loop outcomes.

function RunFunnel({
  run,
  ordersForRun,
}: {
  run: Run | null;
  ordersForRun: Order[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (!run) return null;

  const evaluated = run.markets_evaluated ?? 0;
  const qualified = run.orders_attempted ?? 0;
  const placed = run.orders_placed ?? 0;

  // Compute spread + midpoint stats from the actual placed orders for this run
  const spreads: number[] = [];
  const midpoints: number[] = [];
  for (const o of ordersForRun) {
    if (o.yes_ask_dollars && o.yes_bid_dollars) {
      spreads.push(o.yes_ask_dollars - o.yes_bid_dollars);
    }
    if (o.midpoint_dollars) midpoints.push(o.midpoint_dollars);
  }
  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = (arr: number[]) =>
    arr.length === 0 ? null : Math.min(...arr);
  const max = (arr: number[]) =>
    arr.length === 0 ? null : Math.max(...arr);

  const avgSpread = avg(spreads);
  const minSpread = min(spreads);
  const maxSpread = max(spreads);
  const avgMidpoint = avg(midpoints);
  const minMidpoint = min(midpoints);
  const maxMidpoint = max(midpoints);

  // Sort rejection_breakdown into filter-rejections vs placement-outcomes for display
  const breakdown = run.rejection_breakdown ?? {};
  const placementKeys = new Set([
    "placed",
    "failed",
    "stopped_at_budget",
    "not_reached",
  ]);
  const filterReasons: [string, number | string][] = [];
  const placementOutcomes: [string, number | string][] = [];
  for (const [k, v] of Object.entries(breakdown)) {
    if (placementKeys.has(k)) placementOutcomes.push([k, v]);
    else filterReasons.push([k, v]);
  }
  // Sort filter reasons by count descending
  filterReasons.sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-800/40 transition"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-gray-400">
            Last run pipeline
          </h2>
          <div className="flex items-center gap-2 text-sm font-mono">
            <span className="text-gray-300">
              {evaluated.toLocaleString()}
            </span>
            <span className="text-gray-600">→</span>
            <span className="text-indigo-400">{qualified.toLocaleString()}</span>
            <span className="text-gray-600">→</span>
            <span className="text-emerald-400">{placed.toLocaleString()}</span>
          </div>
          <div className="text-xs text-gray-500">
            evaluated → qualified → placed
          </div>
        </div>
        <span className="text-xs text-gray-500">
          {expanded ? "▲ collapse" : "▼ details"}
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-800 grid grid-cols-1 md:grid-cols-3 gap-5 pt-4">
          {/* Filter rejections */}
          <div>
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
              Why markets were filtered out
            </h3>
            {filterReasons.length === 0 ? (
              <p className="text-xs text-gray-600">No data (older run?)</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {filterReasons.map(([reason, count]) => (
                  <li key={reason} className="flex items-center justify-between">
                    <span className="text-gray-400 text-xs">
                      {reason.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono text-gray-300">
                      {Number(count).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Placement outcomes */}
          <div>
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
              Placement loop
            </h3>
            {placementOutcomes.length === 0 ? (
              <p className="text-xs text-gray-600">No data (older run?)</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {placementOutcomes.map(([key, val]) => (
                  <li key={key} className="flex items-center justify-between">
                    <span className="text-gray-400 text-xs">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono text-gray-300">
                      {String(val)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Stats from actual placed orders */}
          <div>
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
              Placed-order stats
            </h3>
            {ordersForRun.length === 0 ? (
              <p className="text-xs text-gray-600">No orders placed in this run</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">midpoint range</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${minMidpoint?.toFixed(3)} – ${maxMidpoint?.toFixed(3)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">avg midpoint</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${avgMidpoint?.toFixed(4)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">spread range</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${minSpread?.toFixed(3)} – ${maxSpread?.toFixed(3)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">avg spread</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${avgSpread?.toFixed(4)}
                  </span>
                </li>
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const sorted = [...data].sort((a, b) =>
    a.trade_date.localeCompare(b.trade_date)
  );
  let cumulative = 0;
  const chartData = sorted.map((d) => {
    cumulative += Number(d.realized_pnl);
    return {
      date: d.trade_date,
      cumulative: parseFloat(cumulative.toFixed(4)),
    };
  });

  const isPositive = cumulative >= 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-400 mb-4">
        Cumulative P&amp;L (after fees)
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
                "Limit",
                "Filled @",
                "Result",
                "Fees",
                "Net P&L",
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
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  No orders yet.
                </td>
              </tr>
            )}
            {orders.map((o) => {
              const netPnl =
                o.pnl_dollars == null
                  ? null
                  : o.pnl_dollars - (o.fees_dollars ?? 0);
              const pnlColor =
                netPnl == null
                  ? "text-gray-400"
                  : netPnl >= 0
                  ? "text-emerald-400"
                  : "text-red-400";

              const filledAtPerContract =
                o.fill_cost_dollars != null && o.filled_count
                  ? `$${(o.fill_cost_dollars / o.filled_count).toFixed(2)}`
                  : o.fill_cost_dollars === 0
                  ? "$0.00"
                  : "—";

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
                    {filledAtPerContract}
                  </td>
                  <td className="px-4 py-3">
                    <ResultBadge result={o.settlement_result} />
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs whitespace-nowrap">
                    {o.fees_dollars != null
                      ? `$${o.fees_dollars.toFixed(4)}`
                      : "—"}
                  </td>
                  <td className={`px-4 py-3 font-mono font-medium ${pnlColor}`}>
                    {fmt.dollars(netPnl)}
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
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  async function load() {
    setLoading(true);
    const [statsRes, dailyRes, ordersRes, runsRes] = await Promise.all([
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
      supabase
        .from("runs")
        .select("*")
        .order("run_at", { ascending: false })
        .limit(1),
    ]);
    if (statsRes.data) setStats(statsRes.data);
    if (dailyRes.data) setDailyPnl(dailyRes.data);
    if (ordersRes.data) setOrders(ordersRes.data);
    if (runsRes.data && runsRes.data.length > 0) setLastRun(runsRes.data[0]);
    setLastUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // Filter to only orders belonging to the current/most-recent run
  const ordersForLastRun = lastRun
    ? orders.filter((o) => o.run_id === lastRun.id)
    : [];

  const pnlColor =
    !stats || stats.total_pnl == null
      ? "text-white"
      : stats.total_pnl >= 0
      ? "text-emerald-400"
      : "text-red-400";

  const preFeeStr =
    stats?.total_pnl_pre_fees != null
      ? `${stats.total_pnl_pre_fees >= 0 ? "+" : ""}$${Math.abs(
          stats.total_pnl_pre_fees
        ).toFixed(2)} pre-fee`
      : "";

  return (
    <div className="min-h-screen px-4 py-8 max-w-7xl mx-auto">
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

      <LastRunBanner run={lastRun} />
      <KillSwitch />
      <RunFunnel run={lastRun} ordersForRun={ordersForLastRun} />

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
          label="Net P&L"
          value={fmt.dollars(stats?.total_pnl)}
          sub={preFeeStr || `Spent: $${stats?.total_spent?.toFixed(2) ?? "0.00"}`}
          color={pnlColor}
        />
        <StatCard
          label="Total Fees"
          value={
            stats?.total_fees != null ? `$${stats.total_fees.toFixed(2)}` : "—"
          }
          sub={
            stats?.total_pnl_pre_fees != null && stats.total_pnl_pre_fees > 0
              ? `${(
                  (100 * (stats.total_fees ?? 0)) /
                  stats.total_pnl_pre_fees
                ).toFixed(1)}% of gross P&L`
              : "Lifetime"
          }
          color="text-orange-300"
        />
      </div>

      {dailyPnl.length > 0 && (
        <div className="mb-6">
          <PnLChart data={dailyPnl} />
        </div>
      )}

      <OrdersTable orders={orders} />

      <p className="text-center text-xs text-gray-700 mt-6">
        kalshi.webreads.org · data via Supabase
      </p>
    </div>
  );
}