// Monetization scaffolding. Everything here is PREPARED but INACTIVE:
// PAYMENTS_ENABLED=false means all calls are free within rate limits.
// Activation requires no code changes, only config — and only after the
// external-demand thresholds encoded in dashboard.ts are met.

import type { Env } from "./types";
import { hashIdentity } from "./telemetry";

export const PRICING = {
  currency: "USD",
  free_tier: {
    anonymous_daily_calls: 100,
    keyed_daily_calls: 500,
    note: "Free validation stage. Generous limits so agents can evaluate the service.",
  },
  paid: {
    enriched_check_per_call: 0.02,
    starter_monthly: { price: 19, enriched_calls: 2000 },
    builder_monthly: { price: 49, enriched_calls: 10000 },
    status: "prepared_not_active",
    rails_planned: ["x402", "prepaid_credits"],
  },
} as const;

export function paymentsEnabled(env: Env): boolean {
  return env.PAYMENTS_ENABLED === "true";
}

// x402-style 402 challenge (stub — served only when payments are enabled AND
// the caller has no entitlement). Schema kept minimal and versioned so it can
// be finalized against the live x402 spec at activation time.
export function paymentRequiredResponse(env: Env, resource: string): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      error: "Payment required for this call volume.",
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "20000", // $0.02 in USDC 6-decimals
          resource: `${env.PUBLIC_BASE_URL}${resource}`,
          description: "UpgradeLens enriched dependency upgrade analysis",
          mimeType: "application/json",
          payTo: "UNSET — configured at activation",
          maxTimeoutSeconds: 60,
          asset: "USDC",
        },
      ],
      free_alternative:
        "A free evaluation quota remains available. Create a key via POST /v1/keys.",
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

export async function createApiKey(
  env: Env,
  label: string | null,
): Promise<{ key: string; plan: string; daily_quota: number }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key =
    "ul_" +
    [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const keyHash = await hashIdentity(key);
  await env.DB.prepare(
    `INSERT INTO api_clients (key_hash, label, plan, internal, daily_quota, created_at)
     VALUES (?,?,?,0,500,?)`,
  )
    .bind(keyHash, (label ?? "").slice(0, 100) || null, "free", new Date().toISOString())
    .run();
  return { key, plan: "free", daily_quota: 500 };
}

export function recordLedgerEntry(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  entry: {
    client_key: string;
    request_id: string;
    entry_type: "debit" | "credit" | "fee";
    amount_usd: number;
    rail?: string;
    note?: string;
  },
): void {
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO billing_ledger (ts, client_key, request_id, entry_type, amount_usd, rail, note)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(
        new Date().toISOString(),
        entry.client_key,
        entry.request_id,
        entry.entry_type,
        entry.amount_usd,
        entry.rail ?? null,
        entry.note ?? null,
      )
      .run()
      .catch(() => {}),
  );
}
