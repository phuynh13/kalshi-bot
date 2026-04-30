import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Types matching our schema ──────────────────────────────────────────────────

export type Order = {
  id: string;
  run_id: string;
  kalshi_order_id: string;
  ticker: string;
  event_ticker: string;
  market_title: string;
  category: string;
  yes_bid_dollars: number;
  yes_ask_dollars: number;
  midpoint_dollars: number;
  order_price_dollars: number;       // limit price the bot bid at
  contracts: number;
  status: string;
  close_time: string;
  expiration_time: string;
  created_at: string;
  settlement_result: "yes" | "no" | "cancelled" | "unknown" | null;
  payout_dollars: number | null;
  pnl_dollars: number | null;        // gross (pre-fee), based on real fill cost
  fees_dollars: number | null;       // actual fees from Kalshi (taker + maker)
  fill_cost_dollars: number | null;  // actual $ paid (vs limit price)
  filled_count: number | null;       // actual contracts filled
  settled_at: string | null;
};

export type Run = {
  id: string;
  run_at: string;
  markets_evaluated: number;
  orders_attempted: number;
  orders_placed: number;
  total_spent_dollars: number;
  daily_limit_dollars: number;
  demo_mode: boolean;
};

export type DailyPnl = {
  trade_date: string;
  total_orders: number;
  wins: number;
  losses: number;
  cancelled: number;
  total_spent: number;                // uses real fill cost when available
  realized_pnl_pre_fees: number;
  daily_fees: number;
  realized_pnl: number;               // fee-adjusted
  win_rate_pct: number | null;
};

export type LifetimeStats = {
  total_orders: number;
  settled_orders: number;
  cancelled_orders: number;
  pending_orders: number;
  total_wins: number;
  total_losses: number;
  total_pnl_pre_fees: number;
  total_fees: number;
  total_pnl: number;                  // net = gross - fees
  total_spent: number;
  win_rate_pct: number | null;
  avg_entry_price: number | null;
};