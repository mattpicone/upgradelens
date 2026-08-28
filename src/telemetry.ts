// Usage telemetry with strict internal/external classification.
// Internal traffic (owner, CI, health checks, monitors) NEVER counts toward
// business metrics. No secrets, no request bodies, no private data logged.

import type { Env } from "./types";

export interface UsageEvent {
  request_id: string;
  external: boolean;
  client_key: string; // hashed key prefix or anon ip hash — never raw identifiers
  surface: "rest" | "mcp" | "dashboard" | "meta";
  tool: string;
  ecosystem?: string;
  package?: string;
  cache_hit: boolean;
  status: number;
  latency_ms: number;
  unknown_result: boolean;
  price_usd: number;
  cost_usd: number;
  user_agent?: string;
  referrer?: string;
}

const INTERNAL_UA_PATTERNS = [
  /upgradelens-ci/i,
  /upgradelens-monitor/i,
  /github-actions-health/i,
];

export async function hashIdentity(input: string): Promise<string> {
  const data = new TextEncoder().encode("ul1:" + input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CallerIdentity {
  clientKey: string; // "key:<hash8>" or "anon:<iphash8>"
  internal: boolean;
  keyed: boolean;
  plan: string;
  dailyQuota: number;
}

export async function identifyCaller(env: Env, request: Request): Promise<CallerIdentity> {
  const ua = request.headers.get("user-agent") ?? "";
  const uaInternal = INTERNAL_UA_PATTERNS.some((re) => re.test(ua));

  const auth = request.headers.get("authorization") ?? "";
  const headerKey = request.headers.get("x-api-key") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const rawKey = bearer || headerKey;

  if (rawKey) {
    // Owner token is always internal.
    if (env.OWNER_TOKEN && rawKey === env.OWNER_TOKEN) {
      return { clientKey: "owner", internal: true, keyed: true, plan: "owner", dailyQuota: 1_000_000 };
    }
    const keyHash = await hashIdentity(rawKey);
    try {
      const row = await env.DB.prepare(
        `SELECT plan, internal, daily_quota FROM api_clients WHERE key_hash = ?`,
      )
        .bind(keyHash)
        .first<{ plan: string; internal: number; daily_quota: number }>();
      if (row) {
        return {
          clientKey: `key:${keyHash}`,
          internal: row.internal === 1 || uaInternal,
          keyed: true,
          plan: row.plan,
          dailyQuota: row.daily_quota,
        };
      }
    } catch {
      /* fall through to anonymous */
    }
  }

  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  const ipHash = await hashIdentity(ip);
  return {
    clientKey: `anon:${ipHash}`,
    internal: uaInternal,
    keyed: false,
    plan: "anon",
    dailyQuota: 100,
  };
}

export interface WaitCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export function recordUsage(env: Env, ctx: WaitCtx, e: UsageEvent): void {
  const stmt = env.DB.prepare(
    `INSERT INTO usage_events
       (request_id, ts, external, client_key, surface, tool, ecosystem, package,
        cache_hit, status, latency_ms, unknown_result, price_usd, cost_usd, user_agent, referrer)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    e.request_id,
    new Date().toISOString(),
    e.external ? 1 : 0,
    e.client_key,
    e.surface,
    e.tool,
    e.ecosystem ?? null,
    e.package ?? null,
    e.cache_hit ? 1 : 0,
    e.status,
    e.latency_ms,
    e.unknown_result ? 1 : 0,
    e.price_usd,
    e.cost_usd,
    (e.user_agent ?? "").slice(0, 200) || null,
    (e.referrer ?? "").slice(0, 200) || null,
  );
  ctx.waitUntil(stmt.run().catch(() => {}));
}

// ---- Rate limiting (D1 counters; KV free tier writes are too scarce) -------

export interface RateResult {
  allowed: boolean;
  remaining_day: number;
  retry_after_s?: number;
}

const MINUTE_LIMIT_ANON = 20;
const MINUTE_LIMIT_KEYED = 60;

export async function checkRateLimit(env: Env, caller: CallerIdentity): Promise<RateResult> {
  if (caller.internal) return { allowed: true, remaining_day: 999999 };
  const now = new Date();
  const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const day = now.toISOString().slice(0, 10);
  const minuteBucket = `m:${minute}:${caller.clientKey}`;
  const dayBucket = `d:${day}:${caller.clientKey}`;
  const minuteExp = new Date(now.getTime() + 2 * 60_000).toISOString();
  const dayExp = new Date(now.getTime() + 25 * 60 * 60_000).toISOString();

  try {
    const [mRes, dRes] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(minuteBucket, minuteExp),
      env.DB.prepare(
        `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(dayBucket, dayExp),
    ]);
    const mCount = (mRes?.results?.[0] as { count?: number } | undefined)?.count ?? 1;
    const dCount = (dRes?.results?.[0] as { count?: number } | undefined)?.count ?? 1;
    const minuteLimit = caller.keyed ? MINUTE_LIMIT_KEYED : MINUTE_LIMIT_ANON;
    if (mCount > minuteLimit) {
      return { allowed: false, remaining_day: Math.max(0, caller.dailyQuota - dCount), retry_after_s: 60 };
    }
    if (dCount > caller.dailyQuota) {
      return { allowed: false, remaining_day: 0, retry_after_s: 3600 };
    }
    return { allowed: true, remaining_day: Math.max(0, caller.dailyQuota - dCount) };
  } catch {
    // Fail open: availability beats strictness for a read-only free service.
    return { allowed: true, remaining_day: -1 };
  }
}

export async function cleanupRateCounters(env: Env): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM rate_counters WHERE expires_at < ?`)
      .bind(new Date().toISOString())
      .run();
  } catch {
    /* best effort */
  }
}
