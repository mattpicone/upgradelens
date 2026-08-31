// Billing compatibility surface. The active v0.3 rail lives in payment.ts;
// these exports preserve the legacy accounting helpers for existing operators
// while ensuring a config flag alone can never activate charging.

import type { Env } from "./types";
import { hashApiKey } from "./telemetry";
import { paymentActivation as machinePaymentActivation } from "./payment";

export const PRICING = {
  currency: "USD",
  free_tier: {
    units_per_network_identity: 1,
    rolling_days: 30,
    note: "One free business unit per pseudonymous network identity; shared by MCP and REST.",
  },
  paid: {
    unit_price_usd: 0.01,
    unit_price_atomic_usdc: "10000",
    rail: "x402-v2",
    status: "machine_only",
  },
} as const;

export function paymentsEnabled(env: Env): boolean {
  const activation = machinePaymentActivation(env);
  return activation.ready && (activation.mode === "testnet" || activation.mode === "mainnet");
}

export function paymentActivation(env: Env): {
  requested: boolean;
  ready: boolean;
  blockers: string[];
  mode: string;
} {
  const activation = machinePaymentActivation(env);
  return {
    requested: activation.mode !== "validation",
    ready: activation.ready,
    blockers: activation.blockers,
    mode: activation.mode,
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
