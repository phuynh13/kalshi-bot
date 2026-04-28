# Kalshi Bot

Automated YES limit-order bot for Kalshi prediction markets, with a live dashboard.

## What's in this repo

```
.
├── bot/         Python trading bot (runs as a daily cron on PythonAnywhere)
├── dashboard/   Next.js dashboard (deploys to Vercel)
└── db/          SQL views / migrations for Supabase
```

## How the system works

1. **Bot runs once a day** on PythonAnywhere as a scheduled task.
2. **Bot writes** orders, runs, and settlements to Supabase.
3. **Dashboard reads** from Supabase via the public anon key.
4. **Vercel auto-deploys** the dashboard whenever this repo's `main` branch updates.

The bot and dashboard never talk to each other directly — they communicate
through the database.

## Working on the bot

```bash
cd bot
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # then fill in real values
python auth_test.py                  # smoke test — should print "Auth OK"
python bot.py                        # run a real cycle
```

The bot needs a Kalshi API key + private key file. The private key MUST live
outside the repo (it's in `.gitignore`). Point `KALSHI_PRIVATE_KEY_PATH` at
wherever you keep it.

## Working on the dashboard

```bash
cd dashboard
npm install
cp .env.local.example .env.local     # then fill in Supabase URL + anon key
npm run dev                          # http://localhost:3000
```

Vercel deploys `dashboard/` automatically on push to `main`. The Vercel project
must be configured with Root Directory = `dashboard`.

## Database changes

SQL files in `db/views/` are applied manually via the Supabase SQL editor.
See `db/README.md` for the running list of what's been applied.

## Running tests / lints locally

```bash
# Bot
cd bot && python -m py_compile *.py     # syntax check

# Dashboard
cd dashboard && npm run build           # full type check + build
```

CI runs these on every PR via `.github/workflows/ci.yml`.
