# Database Migrations

Supabase doesn't have built-in migration tooling for this kind of project,
so we track applied SQL files manually in this README.

When you make a schema change:

1. Add a numbered file under `views/` (or create a new subfolder for tables, etc.)
2. Run it in the Supabase SQL editor
3. Append a row to the table below with the date you applied it

## Applied

| File                               | Applied on  | Notes                                                  |
|------------------------------------|-------------|--------------------------------------------------------|
| `views/001_lifetime_stats.sql`     | 2026-04-27  | Adds `pending_orders` and `avg_entry_price` to view    |
| `views/002_fee_tracking.sql`       | (pending)   | Adds `fees_dollars`, `fill_cost_dollars`, `filled_count` |

## Not yet applied

(none)
## Known security warnings

Next.js 14.2.35 has open advisories that are only fixed in Next.js 15+.
We're staying on 14 because:
- Dashboard is Vercel-hosted (mitigates self-hosted-only CVEs)
- Single user, no untrusted input (limits XSS / DoS exposure)
- A Next.js 15 migration is a separate, deliberate task

Reassess when:
- Migrating off Vercel
- Adding multi-user features
- A critical CVE appears that affects 14.x AND has no backport