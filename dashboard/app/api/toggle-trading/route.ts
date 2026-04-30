// dashboard/app/api/toggle-trading/route.ts
//
// API route to toggle the bot's kill switch. Uses the Supabase service-role
// key (server-only) so the anon key in the browser can't directly write to
// bot_config — only this endpoint can.
//
// POST body: { enabled: boolean }
// Returns:   { ok: true, enabled: boolean } on success
//            { ok: false, error: string }   on failure

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// These run server-side only — the service key never reaches the browser.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export async function POST(request: Request) {
  // Validate env vars are present at request time. If either is missing
  // (misconfigured Vercel project), fail with a clear error rather than crash.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json(
      { ok: false, error: "Server configuration missing" },
      { status: 500 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Validate the request shape — must be { enabled: boolean }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { enabled?: unknown }).enabled !== "boolean"
  ) {
    return NextResponse.json(
      { ok: false, error: "Body must be { enabled: boolean }" },
      { status: 400 }
    );
  }

  const enabled = (body as { enabled: boolean }).enabled;

  // Server-side Supabase client with full write access.
  // Created per-request rather than at module load to avoid issues with
  // Next.js's edge/serverless boundaries.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { error } = await supabase
    .from("bot_config")
    .update({
      value: enabled ? "true" : "false",
      updated_at: new Date().toISOString(),
    })
    .eq("key", "trading_enabled");

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, enabled });
}
