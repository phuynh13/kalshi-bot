// lib/kalshi-server.ts
//
// Shared server-side Kalshi utilities.
// Import this into any API route that needs to call Kalshi.
//
// Why this exists:
//   The auth logic (RSA-PSS signing) is identical across every Kalshi API
//   route. Keeping it in one place means if Kalshi's auth scheme ever changes,
//   there is exactly one file to update.
//
// Never import this in client components — it uses Node crypto and your
// private key. It only runs server-side (API routes, Server Components).

import crypto from "crypto";

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com";

const API_KEY_ID = process.env.KALSHI_API_KEY_ID!;
const PRIVATE_KEY_PEM = process.env.KALSHI_PRIVATE_KEY_PEM!;

// ── Auth headers ─────────────────────────────────────────────────────────────
//
// Kalshi uses RSA-PSS / SHA-256 signatures.
// The message being signed is: timestamp + METHOD + path (no query string).
// This must match exactly — the Python bot uses the same scheme.

export function buildAuthHeaders(
  method: string,
  path: string
): Record<string, string> {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  signer.end();

  const signature = signer
    .sign({
      key: PRIVATE_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

// ── GET helper ────────────────────────────────────────────────────────────────
//
// Wraps fetch with auth headers.
// Note: signs the path WITHOUT query string — Kalshi's requirement.
// Query params are appended to the URL but not included in the signature.

export async function kalshiGet(
  path: string,
  params?: Record<string, string>
): Promise<unknown> {
  if (!API_KEY_ID || !PRIVATE_KEY_PEM) {
    throw new Error("Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM env vars");
  }

  const url = new URL(KALSHI_BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  // Sign path only — no query string
  const headers = buildAuthHeaders("GET", path);

  const resp = await fetch(url.toString(), { headers });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kalshi ${path} returned ${resp.status}: ${text}`);
  }

  return resp.json();
}