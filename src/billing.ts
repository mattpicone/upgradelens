// Monetization scaffolding. Payments remain deliberately unavailable until a
// verifier/settler, destination, replay protection, and entitlement lifecycle
// are implemented and tested. A config flag alone can never activate charging.

import type { Env } from "./types";
import { hashApiKey } from "./telemetry";

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
    status: "blocked_pending_payment_implementation",
    rails_planned: ["x402", "prepaid_credits"],
  },
} as const;

export function paymentsEnabled(env: Env): boolean {
  return paymentActivation(env).ready;
}

export function paymentActivation(env: Env): {
  requested: boolean;
  ready: false;
  blockers: string[];
} {
  return {
    requested: env.PAYMENTS_ENABLED === "true",
    ready: false,
    blockers: [
      ...(env.X402_PAY_TO ? [] : ["X402_PAY_TO is not configured"]),
      "x402 v2 payment verification and settlement are not implemented",
      "replay protection and paid entitlement lifecycle are not implemented",
    ],
  };
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
  const keyHash = await hashApiKey(key);
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
