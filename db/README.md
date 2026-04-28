# Database Migrations

Supabase doesn't have built-in migration tooling for this kind of project,
so we track applied SQL files manually in this README.

When you make a schema change:

1. Add a numbered file under `views/` (or create a new subfolder for tables, etc.)
2. Run it in the Supabase SQL editor
3. Append a row to the table below with the date you applied it

## Applied

| File                                | Applied on  | Notes                                                  |
|-------------------------------------|-------------|--------------------------------------------------------|
| `views/001_lifetime_stats.sql`      | YYYY-MM-DD  | Adds `pending_orders` and `avg_entry_price` to view    |

## Not yet applied

(none)
