# Kalshi Bot

An automated prediction market trading bot that places YES limit orders on
[Kalshi](https://kalshi.com), with a live performance dashboard at
[kalshi.webreads.org](https://kalshi.webreads.org).

## What This Is

The bot implements a mechanical, rules-based strategy: each morning it scans
every Kalshi market closing within 24 hours, filters for markets whose implied
probability falls between 58–85% with decent liquidity, and buys 1 YES contract
per qualifying market at the midpoint price — up to a daily dollar budget.

No prediction or forecasting is involved. The bot is a systematic buyer of
high-probability YES outcomes, betting that prices in the 58–85% range are
systematically underpriced. Whether that hypothesis holds is an empirical
question tracked via the dashboard.

---

## Repo Layout

```
.
├── bot/                  Python trading bot (cron job on PythonAnywhere)
│   ├── bot.py            Main entry point — runs one full cycle per day
│   ├── kalshi_client.py  Kalshi API wrapper (auth, markets, orders, settlements)
│   ├── strategy.py       Market qualification logic and price helpers
│   ├── db.py             Supabase read/write layer
│   ├── config.py         Env var loading and validation
│   ├── auth_test.py      Standalone auth diagnostic — run this first
│   └── requirements.txt
├── dashboard/            Next.js dashboard (auto-deploys to Vercel)
│   ├── app/
│   │   ├── page.tsx      Main dashboard UI (React, Recharts, Supabase)
│   │   ├── layout.tsx    App shell
│   │   └── api/
│   │       ├── positions/route.ts       Kalshi live positions proxy
│   │       └── toggle-trading/route.ts  Kill switch toggle
│   └── lib/
│       └── supabase.ts   Supabase client + TypeScript types
└── db/                   SQL migrations (applied manually in Supabase)
    ├── 001_lifetime_stats.sql
    ├── 002_fee_tracking.sql
    ├── 003_bot_config.sql
    ├── 004_run_diagnostics.sql
    └── 005_category_stats.sql
```

---

## Architecture

```
┌──────────────────┐         ┌─────────────────┐         ┌──────────────────┐
│  bot.py (cron)   │ writes  │    Supabase      │  reads  │  page.tsx (web)  │
│  PythonAnywhere  │────────▶│  orders, runs    │◀────────│  Next.js + Vercel│
└──────────────────┘         │  bot_config      │         └──────────────────┘
        │                    │  + SQL views     │                  │
        │ Kalshi API         └─────────────────┘           /api/positions
        ▼                                                         │
api.elections.kalshi.com  ◀──────────────────────────────────────┘
                                                    (live positions + balance)
```

The bot and dashboard never communicate directly. All shared state lives in
Supabase. Each can be updated or redeployed independently.

---

## The Strategy

```
Universe:  All Kalshi markets closing within the next 24 hours
Filter:    status = open
           volume_24h >= 50 contracts
           bid-ask spread <= $0.10
           midpoint price in [0.58, 0.85]  ← implied probability range
           not already ordered today
Action:    Buy 1 YES contract at midpoint price (rounded up to nearest cent)
Budget:    Stop when daily spend limit would be exceeded
```

The core bet: Kalshi prices in the 58–85% range are systematically underpriced.
A contract that the market prices at 70% should resolve YES more than 70% of
the time if there's genuine edge. The dashboard's "Edge over implied odds" chart
tracks this bucket by bucket.

---

## Bot Daily Cycle

Runs once daily via PythonAnywhere cron at **12:00 UTC (5am Pacific)**.

```
1. Stale cleanup    — Orders >7 days past close with no settlement → marked "unknown"
2. Settlement       — Fetch Kalshi's /portfolio/settlements (ground truth)
                      Match against unsettled orders by ticker
                      Record exact fill cost, fees, payout from Kalshi
                      Fallback: check order status for cancellation detection
3. Kill switch      — Read bot_config table; exit if trading disabled
4. Budget check     — Sum today's orders; exit if daily limit reached
5. Market scan      — Fetch all markets closing in next 24h (paginated)
6. Event fetch      — Fetch events for same window → build category lookup
7. Filter           — Run qualifies() on each market; count rejections
8. Place orders     — Buy YES at midpoint until budget would be exceeded
9. Record run       — Insert runs row with rejection breakdown
```

---

## Data Model

### Tables

**`orders`** — one row per limit order placed

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Internal primary key |
| `run_id` | UUID | FK to `runs` |
| `kalshi_order_id` | TEXT | Kalshi's order UUID (archived after settlement) |
| `ticker` | TEXT | Market ticker e.g. `KXWTI-26MAY04-T102.99` |
| `event_ticker` | TEXT | Parent event ticker |
| `market_title` | TEXT | Human-readable market description |
| `category` | TEXT | From parent event (Finance, Economics, Sports…) |
| `yes_bid_dollars` | NUMERIC | Bid at time of order |
| `yes_ask_dollars` | NUMERIC | Ask at time of order |
| `midpoint_dollars` | NUMERIC | Computed midpoint used for strategy decision |
| `order_price_dollars` | NUMERIC | Limit price the bot placed (strategy data) |
| `fill_cost_dollars` | NUMERIC | Actual cost paid (execution data, from settlements) |
| `filled_count` | INTEGER | Contracts actually filled |
| `fees_dollars` | NUMERIC | Fees charged by Kalshi |
| `contracts` | INTEGER | Contracts ordered (always 1 currently) |
| `status` | TEXT | Last known order status |
| `settlement_result` | TEXT | `yes`, `no`, `cancelled`, `unknown`, or NULL |
| `payout_dollars` | NUMERIC | Gross payout received |
| `pnl_dollars` | NUMERIC | Gross P&L (payout - fill_cost) |
| `close_time` | TIMESTAMPTZ | Market close time |

**`runs`** — one row per cron execution

| Column | Description |
|---|---|
| `markets_evaluated` | Total markets in the 24h window |
| `orders_attempted` | Markets that passed all filters |
| `orders_placed` | Orders successfully submitted |
| `total_spent_dollars` | Dollars spent this run |
| `rejection_breakdown` | JSONB: counts per rejection reason |

**`bot_config`** — key/value store for runtime settings

| Key | Description |
|---|---|
| `trading_enabled` | Kill switch. `"false"` skips order placement |

### Views

**`lifetime_stats`** — aggregate totals for the stat cards

**`daily_pnl`** — per-day aggregates for the P&L chart

**`category_stats`** — per-category win rates and P&L for the breakdown table

All money fields in all views use `COALESCE(fill_cost_dollars, order_price_dollars)`
as the cost basis — real fill cost when available, limit price as fallback for
older orders.

---

## Key Kalshi API Findings

Documented here because the API behavior differs from what documentation suggests.

**Markets endpoint** (`/trade-api/v2/markets`) does not return a `category`
field. Category lives on the parent event object. The bot fetches the events
endpoint separately each run and builds an `event_ticker → category` lookup.

**Orders endpoint** (`/trade-api/v2/portfolio/orders/{id}`) returns `404` for
settled orders — Kalshi archives them. Do not use this to check settlement
outcomes. Use the settlements endpoint instead.

**Settlements endpoint** (`/trade-api/v2/portfolio/settlements`) is the ground
truth for fill data. Returns `yes_total_cost_dollars` (dollar string),
`fee_cost` (dollar string), `revenue` (integer cents — note the unit mismatch),
`yes_count_fp` (string), and `market_result`. This is what the bot uses as
its primary settlement path.

**Positions endpoint** (`/trade-api/v2/portfolio/positions`) field names:
- `position_fp` — string, net contract count e.g. `"1.00"`. `"0.00"` means a
  resting (unfilled) limit order, not a filled position
- `market_exposure_dollars` — string, cost basis already in dollars
- `fees_paid_dollars` — string, already in dollars
- `realized_pnl_dollars` — string, already in dollars

Balance endpoint (`/trade-api/v2/portfolio/balance`) returns integer cents,
unlike the positions endpoint which uses dollar strings. Intentional Kalshi
inconsistency.

---

## Settlement Logic

The settlement flow changed significantly from the original implementation.
This is the current design:

```python
# For each unsettled order (past close_time, within 7-day giveup):

if ticker in kalshi_settlements:
    # PRIMARY PATH — ground truth from Kalshi
    # Use yes_total_cost_dollars, fee_cost, revenue, yes_count_fp directly
    record settlement with real fill data
else:
    # FALLBACK — order hasn't settled yet, or was cancelled unfilled
    try order status endpoint:
        "cancelled" / "expired" → mark cancelled, pnl=$0
        "resting"               → market not settled yet, retry tomorrow
        404                     → archived but outside 500-record window, skip
        other                   → log and retry next run
```

Why 500 settlements is enough: at ~$0.70 avg entry and $30/day budget,
~43 orders/day. 7-day giveup window = ~300 max relevant records. 500 has
safe headroom.

---

## Dashboard

Built with Next.js 14, Tailwind CSS, and Recharts. Auto-deploys to Vercel.
Supabase anon key is used client-side for read queries. The Kalshi API is
called server-side via `/api/positions` route — credentials never reach the browser.

### Panels

**Last Run Banner** — bot health status. Red if >26 hours since last run.

**Kill Switch** — reads and writes `bot_config.trading_enabled` via
`/api/toggle-trading`. Uses Supabase service role key (server-side only).

**Live Positions** — calls `/api/positions` which proxies to Kalshi's positions
and balance endpoints. Filters `position_fp == "0.00"` (resting orders) to
show only filled contracts.

**Last Run Pipeline** — evaluated → qualified → placed funnel with per-reason
rejection counts from `runs.rejection_breakdown`.

**Edge over Implied Odds** — the primary strategy chart. Each bar shows:
`actual_win_rate - implied_probability_at_entry`. A bar at $0.70–$0.75 shows
whether you're winning more or less than 72.5% of the time on those contracts.
Labels show edge% and sample size (n=). Faded bars have <10 samples.

**Cumulative P&L** — net P&L after fees, cumulative by day.

**Category Breakdown** — per-category win rate and P&L. Orders placed before
May 5, 2026 show as "Uncategorized" (category field was empty before the
events-endpoint fix). New orders have real categories.

**All Orders** — paginated 25/page. "Filled @" column shows:
- `$X.XX` in white = confirmed real fill price from Kalshi settlements
- `~$X.XX` in amber = estimated, using limit price as proxy (older orders)
- `—` = pending or cancelled, not yet filled

---

## Deployment

| Component | Hosted on | Deploy method |
|---|---|---|
| Bot | PythonAnywhere | Manual `git pull` in bash console |
| Dashboard | Vercel | Auto on push to `main` |
| Database | Supabase | Manual SQL via dashboard editor |

### Updating the bot (PythonAnywhere)

```bash
cd ~/kalshi-bot
git pull
cd bot
python3.10 auth_test.py   # verify auth before cron picks it up
python3.10 bot.py         # optional: run manually to test
```

The cron is intentionally not auto-deployed. A bad bot push costs real money.
Manual deploy = forced review moment.

### Updating the dashboard

```bash
git add dashboard/
git commit -m "dashboard: describe change"
git push origin main      # Vercel picks this up automatically
```

### Applying database migrations

Open the Supabase SQL editor, paste the migration file, run it.
All migrations use `CREATE OR REPLACE VIEW` or `ADD COLUMN IF NOT EXISTS`
— safe to re-run.

---

## Local Development

### Bot

```bash
cd bot
python3.10 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in real values
python3.10 auth_test.py       # should print "Auth OK"
python3.10 bot.py             # runs a full cycle (places real orders in LIVE mode)
```

Set `DEMO_MODE=true` in `.env` to use Kalshi's demo environment.
The private key file must exist at the path set in `KALSHI_PRIVATE_KEY_PATH`
and must never be committed to the repo.

### Dashboard

```bash
cd dashboard
npm install
cp .env.local.example .env.local   # add Supabase URL + anon key
npm run dev                        # http://localhost:3000
```

---

## Design Decisions

**Why fees and fill cost come from Kalshi, not local calculation.**
Kalshi's published fee formula (`0.07 × C × P × (1-P)`) doesn't capture
per-fill rounding and rebate accumulators. The settlements endpoint returns
`fee_cost` directly — authoritative to the cent. Always use upstream data
for money fields.

**Why the bot keeps both `order_price_dollars` and `fill_cost_dollars`.**
The first is "what the strategy decided to bid." The second is "what was
actually paid." For whole-cent single-contract trades they're usually equal,
but they're conceptually distinct. Keeping both allows later analysis of
execution quality.

**Why category requires a separate events fetch.**
Kalshi's `/markets` endpoint does not include category. It's on the parent
event. Confirmed via field audit (May 2026): the `category` key is absent
from market objects. The bot fetches events once per run and builds a lookup.
~5,700 events paginated in ~28 requests — acceptable for a daily cron.

**Why settlement uses `/portfolio/settlements` not `/portfolio/orders/{id}`.**
Kalshi archives settled orders — the order endpoint returns 404 after resolution.
The settlements endpoint is permanent and contains exact fill cost, fees, and
payout. Confirmed May 2026: all orders show `yes_count_fp: "1.00"`, meaning
every settled YES was filled. The 404s were not missing fills — just archiving.

**Why the settlement giveup threshold is 7 days.**
Kalshi settles most markets within 1–15 hours. Combo markets can take ~72 hours.
Past 7 days, something genuinely unusual has happened. Retrying every run wastes
API calls. Stale orders get marked `unknown` and manual review can investigate.

**Why the dashboard calls Kalshi server-side for positions.**
API credentials (private key + key ID) must never reach the browser.
The `/api/positions` Next.js route runs server-side, calls Kalshi, and returns
only position data to the client. No credentials in client-side code.

---

## Current Limitations and Deferred Work

**Category backfill** — orders placed before May 5, 2026 have empty category.
The events endpoint only returns recent events, so backfilling requires a
separate lookup per order's event_ticker. Low priority.

**Fill data backfill** — orders settled before the settlements-endpoint fix
have NULL `fill_cost_dollars`. P&L is still correct (falls back to limit price),
but the "Filled @" column shows amber `~` estimates. These are accurate enough
and don't need correction.

**Single contract size** — the bot always orders 1 contract. No position sizing
logic. A natural next step once strategy edge is confirmed.

**No cancellation of resting orders** — if a market closes without the order
matching, Kalshi expires it and the bot catches this on the next settlement run.
No active monitoring of open resting orders between runs.

**Email alerting** — no alert if the cron misses a day. The dashboard's
"Last Run Banner" turns red after 26 hours, but only if you're watching.

**Backtesting** — the strategy has never been validated against historical data.
The live dashboard is the only feedback loop currently.

---

## Security Notes

The Supabase anon key is used client-side (acceptable — Row Level Security
restricts writes). The service role key is only used in Next.js API routes
(server-side). Kalshi credentials are server-side only.

`bot_config` has RLS enabled: public reads (dashboard can display kill switch
state), writes restricted to service role (only the toggle-trading API route
can flip it).

Next.js 14.2.x has open advisories fixed in Next.js 15+. Staying on 14 because
the dashboard is Vercel-hosted (mitigates self-hosted CVEs), single-user with no
untrusted input. Reassess when moving off Vercel or adding multi-user features.

---

## Quick Reference: Key Numbers

| Parameter | Value | Configured in |
|---|---|---|
| Daily spend limit | $30.00 | `.env` `DAILY_SPEND_LIMIT` |
| Min implied probability | 58% | `.env` `MIN_PROBABILITY` |
| Max implied probability | 85% | `.env` `MAX_PROBABILITY` |
| Contracts per order | 1 | `.env` `CONTRACTS_PER_ORDER` |
| Min 24h volume | 50 contracts | `.env` `MIN_VOLUME_24H` |
| Max bid-ask spread | $0.10 | `.env` `MAX_SPREAD` |
| Hours to close window | 24 | `.env` `HOURS_TO_CLOSE` |
| Settlement giveup | 7 days | `db.py` `SETTLEMENT_GIVEUP_DAYS` |
| Settlements fetched | 500 | `bot.py` `get_settlements(limit=500)` |
| Cron schedule | 12:00 UTC daily | PythonAnywhere scheduler |