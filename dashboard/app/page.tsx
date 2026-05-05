"use client";

import { useEffect, useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import {
  supabase,
  Order,
  DailyPnl,
  LifetimeStats,
  Run,
  CategoryStats,
  KalshiPosition,
  KalshiBalance,
} from "../lib/supabase";

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
  // Convert Kalshi's integer cents to a display dollar string
  centsToDollars: (cents: number | null | undefined) =>
    cents == null ? "—" : `$${(cents / 100).toFixed(2)}`,
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

// ── Open Positions Panel ─────────────────────────────────────────────────────
// Live exposure + balance pulled from Kalshi via /api/positions.
// Shown collapsed by default; expand to see per-position breakdown.

function OpenPositionsPanel() {
  const [positions, setPositions] = useState<KalshiPosition[] | null>(null);
  const [balance, setBalance] = useState<KalshiBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/positions");
      const json = await resp.json();
      if (!resp.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }
      // Filter out positions with 0 contracts (these are settled-but-not-yet-removed)
      const activePositions = (json.positions as KalshiPosition[]).filter(
        (p) => p.position !== 0
      );
      setPositions(activePositions);
      setBalance(json.balance);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Aggregate exposure across all open positions
  const totalExposureCents = positions
    ? positions.reduce((sum, p) => sum + (p.market_exposure ?? 0), 0)
    : 0;
  const totalContracts = positions
    ? positions.reduce((sum, p) => sum + Math.abs(p.position ?? 0), 0)
    : 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-800/40 transition"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-gray-400">Live positions</h2>
          {loading ? (
            <span className="text-xs text-gray-500">loading…</span>
          ) : error ? (
            <span className="text-xs text-red-400">error: {error}</span>
          ) : positions === null ? null : (
            <div className="flex items-center gap-3 text-sm font-mono">
              <span className="text-gray-300">{positions.length}</span>
              <span className="text-xs text-gray-500">positions ·</span>
              <span className="text-gray-300">{totalContracts}</span>
              <span className="text-xs text-gray-500">contracts ·</span>
              <span className="text-gray-300">
                {fmt.centsToDollars(totalExposureCents)}
              </span>
              <span className="text-xs text-gray-500">at risk</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {balance && (
            <span className="text-xs text-gray-500 hidden sm:inline">
              balance:{" "}
              <span className="text-gray-300 font-mono">
                {fmt.centsToDollars(balance.balance)}
              </span>
            </span>
          )}
          <span className="text-xs text-gray-500">
            {expanded ? "▲ collapse" : "▼ details"}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-800 pt-4">
          {error ? (
            <p className="text-xs text-red-400">
              Could not fetch positions: {error}
            </p>
          ) : positions === null || positions.length === 0 ? (
            <p className="text-xs text-gray-500">No open positions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    {["Ticker", "Side", "Contracts", "Cost basis", "Realized", "Fees"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {positions.map((p) => (
                    <tr key={p.ticker} className="hover:bg-gray-800/40 transition">
                      <td className="px-3 py-2 font-mono text-xs text-indigo-400">
                        {p.ticker}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span
                          className={
                            p.position > 0
                              ? "text-emerald-400"
                              : "text-red-400"
                          }
                        >
                          {p.position > 0 ? "YES" : "NO"}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-300">
                        {Math.abs(p.position)}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-300">
                        {fmt.centsToDollars(p.market_exposure)}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-500 text-xs">
                        {fmt.centsToDollars(p.realized_pnl)}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-500 text-xs">
                        {fmt.centsToDollars(p.fees_paid)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex justify-end">
                <button
                  onClick={load}
                  className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg px-3 py-1 transition"
                >
                  Refresh
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Run Funnel Breakdown ─────────────────────────────────────────────────────

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
  const minOf = (arr: number[]) => (arr.length === 0 ? null : Math.min(...arr));
  const maxOf = (arr: number[]) => (arr.length === 0 ? null : Math.max(...arr));

  const breakdown = run.rejection_breakdown ?? {};
  const placementKeys = new Set(["placed", "failed", "stopped_at_budget", "not_reached"]);
  const filterReasons: [string, number | string][] = [];
  const placementOutcomes: [string, number | string][] = [];
  for (const [k, v] of Object.entries(breakdown)) {
    if (placementKeys.has(k)) placementOutcomes.push([k, v]);
    else filterReasons.push([k, v]);
  }
  filterReasons.sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-800/40 transition"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-gray-400">Last run pipeline</h2>
          <div className="flex items-center gap-2 text-sm font-mono">
            <span className="text-gray-300">{evaluated.toLocaleString()}</span>
            <span className="text-gray-600">→</span>
            <span className="text-indigo-400">{qualified.toLocaleString()}</span>
            <span className="text-gray-600">→</span>
            <span className="text-emerald-400">{placed.toLocaleString()}</span>
          </div>
          <div className="text-xs text-gray-500">evaluated → qualified → placed</div>
        </div>
        <span className="text-xs text-gray-500">
          {expanded ? "▲ collapse" : "▼ details"}
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-800 grid grid-cols-1 md:grid-cols-3 gap-5 pt-4">
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
                    <span className="font-mono text-gray-300">{String(val)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
                    ${minOf(midpoints)?.toFixed(3)} – ${maxOf(midpoints)?.toFixed(3)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">avg midpoint</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${avg(midpoints)?.toFixed(4)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">spread range</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${minOf(spreads)?.toFixed(3)} – ${maxOf(spreads)?.toFixed(3)}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-gray-400 text-xs">avg spread</span>
                  <span className="font-mono text-gray-300 text-xs">
                    ${avg(spreads)?.toFixed(4)}
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

// ── Win Rate by Entry Price Bucket ───────────────────────────────────────────
// Bar chart: 5¢ buckets, win rate on Y axis, sample size as bar opacity.
// Categories with <10 settled samples are de-emphasized as statistically noisy.

const MIN_RELIABLE_SAMPLE = 10;
const BUCKET_WIDTH = 0.05; // 5¢ buckets
const BUCKET_START = 0.55; // 55¢ — covers your 58–85% range with a buffer
const BUCKET_END = 0.90;

function WinRateByPriceChart({ orders }: { orders: Order[] }) {
  const buckets = useMemo(() => {
    // Create bucket bins
    type Bucket = {
      range: string;          // "$0.60–$0.65"
      lower: number;
      wins: number;
      losses: number;
      total: number;
      winRate: number | null;
      reliable: boolean;
    };
    const bins: Bucket[] = [];
    for (let lower = BUCKET_START; lower < BUCKET_END; lower += BUCKET_WIDTH) {
      const upper = lower + BUCKET_WIDTH;
      bins.push({
        range: `$${lower.toFixed(2)}-$${upper.toFixed(2)}`,
        lower: parseFloat(lower.toFixed(2)),
        wins: 0,
        losses: 0,
        total: 0,
        winRate: null,
        reliable: false,
      });
    }

    // Count each settled order into its bucket using actual fill cost per contract
    for (const o of orders) {
      if (o.settlement_result !== "yes" && o.settlement_result !== "no") continue;
      // Use per-contract fill price; fall back to limit price if fill data missing
      const price =
        o.fill_cost_dollars != null && o.filled_count
          ? o.fill_cost_dollars / o.filled_count
          : o.order_price_dollars;
      if (!price) continue;

      const idx = Math.floor((price - BUCKET_START) / BUCKET_WIDTH);
      if (idx < 0 || idx >= bins.length) continue;
      const bucket = bins[idx];
      if (o.settlement_result === "yes") bucket.wins++;
      else bucket.losses++;
      bucket.total++;
    }

    // Compute win rate + reliability flag
    for (const b of bins) {
      if (b.total > 0) {
        b.winRate = (100 * b.wins) / b.total;
        b.reliable = b.total >= MIN_RELIABLE_SAMPLE;
      }
    }
    return bins;
  }, [orders]);

  const hasData = buckets.some((b) => b.total > 0);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium text-gray-400">
          Win rate by entry price
        </h2>
        <span className="text-xs text-gray-600">
          fade = small sample (&lt;{MIN_RELIABLE_SAMPLE})
        </span>
      </div>
      <p className="text-xs text-gray-600 mb-4">
        Settled orders bucketed by actual fill price. Dashed line = breakeven at price (1−p).
      </p>

      {!hasData ? (
        <p className="text-sm text-gray-500 py-8 text-center">
          No settled orders yet.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={buckets}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="range"
              tick={{ fill: "#6b7280", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval={0}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: "#6b7280", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#111827",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(_v: number, _n: string, p: { payload: { wins: number; losses: number; total: number; winRate: number | null } }) => {
                const d = p.payload;
                return [
                  `${d.winRate?.toFixed(1) ?? "—"}% (${d.wins}W / ${d.losses}L, n=${d.total})`,
                  "Win rate",
                ];
              }}
            />
            {/* Reference line at 50% — coin-flip baseline */}
            <ReferenceLine y={50} stroke="#374151" strokeDasharray="3 3" />
            <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
              {buckets.map((b, i) => (
                <Cell
                  key={i}
                  fill={
                    b.winRate == null
                      ? "#1f2937"
                      : b.winRate >= 50
                      ? "#10b981"
                      : "#ef4444"
                  }
                  fillOpacity={b.reliable ? 1 : 0.35}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Category Breakdown ───────────────────────────────────────────────────────

function CategoryBreakdown({ stats }: { stats: CategoryStats[] }) {
  if (stats.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-400">
          Performance by category
        </h2>
        <p className="text-xs text-gray-600 mt-0.5">
          Categories with &lt;{MIN_RELIABLE_SAMPLE} settled orders are dimmed (small sample noise)
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {["Category", "Settled", "Wins", "Losses", "Win Rate", "Spent", "Fees", "Net P&L"].map((h) => (
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
            {stats.map((s) => {
              const reliable = s.settled_orders >= MIN_RELIABLE_SAMPLE;
              const pnlColor =
                s.net_pnl == null
                  ? "text-gray-400"
                  : s.net_pnl >= 0
                  ? "text-emerald-400"
                  : "text-red-400";
              const winRateColor =
                s.win_rate_pct == null
                  ? "text-gray-400"
                  : s.win_rate_pct >= 58
                  ? "text-emerald-400"
                  : "text-red-400";
              const opacity = reliable ? "opacity-100" : "opacity-40";
              return (
                <tr key={s.category} className={`hover:bg-gray-800/40 transition ${opacity}`}>
                  <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                    {s.category}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-300">
                    {s.settled_orders}
                  </td>
                  <td className="px-4 py-3 font-mono text-emerald-400 text-xs">
                    {s.wins}
                  </td>
                  <td className="px-4 py-3 font-mono text-red-400 text-xs">
                    {s.losses}
                  </td>
                  <td className={`px-4 py-3 font-mono ${winRateColor}`}>
                    {fmt.pct(s.win_rate_pct)}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-400 text-xs">
                    ${s.total_spent?.toFixed(2) ?? "0.00"}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">
                    ${s.total_fees?.toFixed(4) ?? "0.0000"}
                  </td>
                  <td className={`px-4 py-3 font-mono font-medium ${pnlColor}`}>
                    {fmt.dollars(s.net_pnl)}
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
  const [categoryStats, setCategoryStats] = useState<CategoryStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  async function load() {
    setLoading(true);
    const [statsRes, dailyRes, ordersRes, runsRes, catRes] = await Promise.all([
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
        .limit(500),
      supabase
        .from("runs")
        .select("*")
        .order("run_at", { ascending: false })
        .limit(1),
      supabase.from("category_stats").select("*"),
    ]);
    if (statsRes.data) setStats(statsRes.data);
    if (dailyRes.data) setDailyPnl(dailyRes.data);
    if (ordersRes.data) setOrders(ordersRes.data);
    if (runsRes.data && runsRes.data.length > 0) setLastRun(runsRes.data[0]);
    if (catRes.data) setCategoryStats(catRes.data);
    setLastUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

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
      <OpenPositionsPanel />
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

      <WinRateByPriceChart orders={orders} />

      <CategoryBreakdown stats={categoryStats} />

      <OrdersTable orders={orders} />

      <p className="text-center text-xs text-gray-700 mt-6">
        kalshi.webreads.org · data via Supabase
      </p>
    </div>
  );
}