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

export type AuthState = "none" | "owner" | "valid_key" | "invalid_key";
export type McpTrafficClass = "internal" | "verification" | "external";
export type McpActorClass =
  | "internal"
  | "registry_verifier"
  | "auth_verifier"
  | "crawler_monitor"
  | "external_tool_client"
  | "unknown";
export type McpVerificationKind = "none" | "registry" | "auth" | "audit" | "health" | "crawler";
export type McpEventKind =
  | "transport"
  | "initialize"
  | "notification"
  | "tools_list"
  | "tools_call"
  | "protocol"
  | "legacy_protocol"
  | "invalid"
  | "rate_limited";

export interface McpEvent {
  request_id: string;
  external: boolean;
  traffic_class: McpTrafficClass;
  actor_class: McpActorClass;
  verification_kind: McpVerificationKind;
  classification_reason: string;
  client_key: string;
  http_method: string;
  rpc_method?: string;
  event_kind: McpEventKind;
  requested_tool?: string;
  business_tool?: string;
  known_tool: boolean;
  tool_invoked?: boolean;
  tool_success?: boolean;
  rpc_error_code?: number;
  error_kind?: string;
  protocol_version?: string;
  owned_test: boolean;
  ecosystem?: string;
  package?: string;
  cache_hit: boolean;
  status: number;
  latency_ms: number;
  unknown_result: boolean;
  auth_state: AuthState;
  client_name?: string;
  client_version?: string;
  user_agent?: string;
  referrer?: string;
}

export async function hashIdentity(input: string): Promise<string> {
  const data = new TextEncoder().encode("ul1:" + input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizedNetworkIdentity(request: Request): string {
  const raw =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  const candidate = raw.trim().toLowerCase();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) {
    const octets = candidate.split(".").map((part) => Number(part));
    if (octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return octets.join(".");
    }
  }
  try {
    const parsed = new URL(`http://[${candidate}]`);
    return parsed.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "0.0.0.0";
  }
}

export async function deriveTrialSubject(env: Env, request: Request): Promise<string> {
  const identity = normalizedNetworkIdentity(request);
  if (!env.TRIAL_HMAC_SECRET) return `legacy:${await hashIdentity(identity)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TRIAL_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`upgradelens-trial-v1:${identity}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashApiKey(input: string): Promise<string> {
  const data = new TextEncoder().encode("ul-key-v2:" + input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CallerIdentity {
  clientKey: string; // "key:<hash8>" or "anon:<iphash8>"
  internal: boolean;
  keyed: boolean;
  plan: string;
  dailyQuota: number;
  authState: AuthState;
  trialSubject?: string;
}

export async function identifyCaller(env: Env, request: Request): Promise<CallerIdentity> {
  const trialSubject = await deriveTrialSubject(env, request);
  const auth = request.headers.get("authorization") ?? "";
  const headerKey = request.headers.get("x-api-key") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const rawKey = bearer || headerKey;

  if (rawKey) {
    // Owner token is always internal.
    if (env.OWNER_TOKEN && rawKey === env.OWNER_TOKEN) {
      return {
        clientKey: "owner",
        internal: true,
        keyed: true,
        plan: "owner",
        dailyQuota: 1_000_000,
        authState: "owner",
        trialSubject,
      };
    }
    const keyHash = await hashApiKey(rawKey);
    const legacyHash = await hashIdentity(rawKey);
    try {
      const row = await env.DB.prepare(
        `SELECT plan, internal, daily_quota FROM api_clients WHERE key_hash = ? OR key_hash = ?`,
      )
        .bind(keyHash, legacyHash)
        .first<{ plan: string; internal: number; daily_quota: number }>();
      if (row) {
        return {
          clientKey: `key:${keyHash.slice(0, 16)}`,
          internal: row.internal === 1,
          keyed: true,
          plan: row.plan,
          dailyQuota: row.daily_quota,
          authState: "valid_key",
          trialSubject,
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
    clientKey: `${rawKey ? "invalid" : "anon"}:${ipHash}`,
    internal: false,
    keyed: false,
    plan: "anon",
    dailyQuota: 100,
    authState: rawKey ? "invalid_key" : "none",
    trialSubject,
  };
}

// Self-identified registry crawlers, health probes, security audits and MCP
// census jobs are useful discovery signals, but never business demand. Keep
// this deliberately conservative and transparent; an ordinary agent client
// with an unclassified user-agent remains external.
const REGISTRY_UA = /(?:registry|verifymcp|proofbench)/i;
const AUDIT_UA =
  /(?:sasame-mcp-audit|mcpscan|sentineloracle|endpointaudit|mcpgrade|agentgrade|mcpqueen-grader|upgradelens-payment-probe)/i;
const HEALTH_UA =
  /(?:mcpbeat|mcpwatch|mcp-observatory|stats-prober|liveness-probe|reliability-bureau-spike)/i;
const CRAWLER_UA =
  /(?:\bbot\b|crawler|scraper|mcp-census|measure-mcp|smitherybot|glama|pulsemcp|mcp2-research|golemreachtrustbot|agentindexbot|x402-observatory|nickw-tripwire|mcplookup\.com-probe|hultra-link|api-forge-mcp-index)/i;

export interface McpSourceClassification {
  trafficClass: McpTrafficClass;
  verificationKind: McpVerificationKind;
  reason: string;
}

export function classifyMcpSource(
  internal: boolean,
  authState: AuthState,
  userAgent?: string,
  requestedTool?: string,
): McpSourceClassification {
  if (internal) {
    return { trafficClass: "internal", verificationKind: "none", reason: "authenticated_internal" };
  }
  const ua = userAgent ?? "";
  if (/^__verifymcp_auth_probe_/i.test(requestedTool ?? "") || /verifymcp/i.test(ua)) {
    return { trafficClass: "verification", verificationKind: "auth", reason: "verifymcp_auth_probe" };
  }
  if (authState === "invalid_key") {
    // A supplied key that fails verification is never evidence of organic
    // business demand, regardless of the caller's user-agent string.
    return { trafficClass: "verification", verificationKind: "auth", reason: "invalid_auth_key" };
  }
  if (REGISTRY_UA.test(ua)) {
    return { trafficClass: "verification", verificationKind: "registry", reason: "self_identified_registry" };
  }
  if (AUDIT_UA.test(ua)) {
    return { trafficClass: "verification", verificationKind: "audit", reason: "self_identified_audit" };
  }
  if (HEALTH_UA.test(ua)) {
    return { trafficClass: "verification", verificationKind: "health", reason: "self_identified_health_monitor" };
  }
  if (CRAWLER_UA.test(ua)) {
    return { trafficClass: "verification", verificationKind: "crawler", reason: "self_identified_crawler" };
  }
  return { trafficClass: "external", verificationKind: "none", reason: "unclassified_external" };
}

export function classifyMcpActor(
  source: McpSourceClassification,
  knownTool: boolean,
  toolInvoked: boolean,
): McpActorClass {
  if (source.trafficClass === "internal") return "internal";
  if (source.verificationKind === "registry") return "registry_verifier";
  if (source.verificationKind === "auth") return "auth_verifier";
  if (source.trafficClass === "verification") return "crawler_monitor";
  if (knownTool && toolInvoked) return "external_tool_client";
  return "unknown";
}

export function classifyMcpEvent(rpcMethod?: string, httpMethod = "POST"): McpEventKind {
  if (httpMethod !== "POST") return "transport";
  if (rpcMethod?.startsWith("http:")) return "invalid";
  if (!rpcMethod) return "invalid";
  if (rpcMethod === "initialize") return "initialize";
  if (rpcMethod === "tools/list") return "tools_list";
  if (rpcMethod === "tools/call") return "tools_call";
  if (rpcMethod.startsWith("notifications/")) return "notification";
  return "protocol";
}

export interface WaitCtx {
  waitUntil(promise: Promise<unknown>): void;
}

function referrerOrigin(input?: string): string | null {
  if (!input) return null;
  try {
    const origin = new URL(input).origin;
    return origin === "null" ? null : origin.slice(0, 200);
  } catch {
    return null;
  }
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
    referrerOrigin(e.referrer),
  );
  ctx.waitUntil(
    stmt.run().catch((error: unknown) => {
      console.error("usage_telemetry_write_failed", {
        request_id: e.request_id,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }),
  );
}

export function recordMcpEvent(env: Env, ctx: WaitCtx, e: McpEvent): void {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO mcp_events
       (request_id, ts, external, traffic_class, actor_class, verification_kind,
        classification_reason, classification_version, client_key, http_method, rpc_method,
        event_kind, requested_tool, business_tool, known_tool, tool_invoked, tool_success,
        rpc_error_code, error_kind, protocol_version, owned_test, ecosystem, package, cache_hit,
        status, latency_ms, unknown_result, auth_state, client_name, client_version,
        user_agent, referrer)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    e.request_id,
    new Date().toISOString(),
    e.external ? 1 : 0,
    e.traffic_class,
    e.actor_class,
    e.verification_kind,
    e.classification_reason.slice(0, 120),
    1,
    e.client_key,
    e.http_method.slice(0, 12),
    (e.rpc_method ?? "").slice(0, 80) || null,
    e.event_kind,
    (e.requested_tool ?? "").slice(0, 80) || null,
    (e.business_tool ?? "").slice(0, 80) || null,
    e.known_tool ? 1 : 0,
    e.tool_invoked === undefined ? null : e.tool_invoked ? 1 : 0,
    e.tool_success === undefined ? null : e.tool_success ? 1 : 0,
    e.rpc_error_code ?? null,
    (e.error_kind ?? "").slice(0, 80) || null,
    (e.protocol_version ?? "").slice(0, 24) || null,
    e.owned_test ? 1 : 0,
    (e.ecosystem ?? "").slice(0, 20) || null,
    (e.package ?? "").slice(0, 214) || null,
    e.cache_hit ? 1 : 0,
    e.status,
    e.latency_ms,
    e.unknown_result ? 1 : 0,
    e.auth_state,
    (e.client_name ?? "").slice(0, 100) || null,
    (e.client_version ?? "").slice(0, 40) || null,
    (e.user_agent ?? "").slice(0, 200) || null,
    referrerOrigin(e.referrer),
  );
  ctx.waitUntil(
    stmt.run().catch((error: unknown) => {
      console.error("mcp_telemetry_write_failed", {
        request_id: e.request_id,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }),
  );
}

// ---- Rate limiting (D1 counters; KV free tier writes are too scarce) -------

export interface RateResult {
  allowed: boolean;
  remaining_day: number;
  retry_after_s?: number;
}

const MINUTE_LIMIT_ANON = 20;
const MINUTE_LIMIT_KEYED = 60;
// D1 writes, not Worker requests, are the binding free-tier resource. These
// global guards leave headroom for telemetry, cache records, evidence indexes,
// scheduled work and ordinary database reads.
const GLOBAL_DAILY_ANALYSIS_UNITS = 10_000;
const GLOBAL_DAILY_CACHE_MISSES = 1_000;

export async function checkRateLimit(
  env: Env,
  caller: CallerIdentity,
  options: { daily?: boolean; skipEdge?: boolean; units?: number } = {},
): Promise<RateResult> {
  if (caller.internal) return { allowed: true, remaining_day: 999999 };
  const includeDaily = options.daily !== false;
  const units = Math.max(1, Math.min(20, Math.floor(options.units ?? 1)));
  const now = new Date();
  const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const day = now.toISOString().slice(0, 10);
  const minuteBucket = `m:${minute}:${caller.clientKey}`;
  const dayBucket = `d:${day}:${caller.clientKey}`;
  const globalDayBucket = `g:${day}:analysis`;
  const minuteExp = new Date(now.getTime() + 2 * 60_000).toISOString();
  const dayExp = new Date(now.getTime() + 25 * 60 * 60_000).toISOString();

  try {
    const limiter = caller.keyed ? env.KEY_RATE_LIMITER : env.ANON_RATE_LIMITER;
    const useD1Minute = !limiter && !options.skipEdge;
    if (limiter && !options.skipEdge) {
      const edge = await limiter.limit({ key: caller.clientKey });
      if (!edge.success) {
        return { allowed: false, remaining_day: 0, retry_after_s: 60 };
      }
    }
    if (!includeDaily) return { allowed: true, remaining_day: caller.dailyQuota };
    const minuteLimit = caller.keyed ? MINUTE_LIMIT_KEYED : MINUTE_LIMIT_ANON;

    const increment = async (
      bucket: string,
      expiresAt: string,
      cap: number,
    ): Promise<number | null> => {
      const result = await env.DB.prepare(
        `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + excluded.count
           WHERE count + excluded.count <= ?
         RETURNING count`,
      ).bind(bucket, units, expiresAt, cap).run();
      const count = (result.results?.[0] as { count?: number } | undefined)?.count;
      return typeof count === "number" ? count : null;
    };

    if (useD1Minute) {
      const minuteCount = await increment(minuteBucket, minuteExp, minuteLimit);
      if (minuteCount === null) {
        return { allowed: false, remaining_day: 0, retry_after_s: 60 };
      }
    }

    // Read the global fuse before writing caller state. Once service capacity
    // is exhausted, rejected traffic becomes read-only instead of burning the
    // remaining D1 write quota.
    const globalExisting = await env.DB.prepare(
      `SELECT count FROM rate_counters WHERE bucket = ?`,
    ).bind(globalDayBucket).first<{ count: number }>();
    if ((globalExisting?.count ?? 0) + units > GLOBAL_DAILY_ANALYSIS_UNITS) {
      return { allowed: false, remaining_day: 0, retry_after_s: 3600 };
    }

    const dCount = await increment(dayBucket, dayExp, caller.dailyQuota);
    if (dCount === null) {
      return { allowed: false, remaining_day: 0, retry_after_s: 3600 };
    }
    const gCount = await increment(globalDayBucket, dayExp, GLOBAL_DAILY_ANALYSIS_UNITS);
    if (gCount === null) {
      return { allowed: false, remaining_day: 0, retry_after_s: 3600 };
    }
    const remaining = Math.max(
      0,
      Math.min(caller.dailyQuota - dCount, GLOBAL_DAILY_ANALYSIS_UNITS - gCount),
    );
    return { allowed: true, remaining_day: remaining };
  } catch {
    // Expensive public routes fail closed when quota state is unavailable. This
    // prevents an exhausted D1 quota from disabling the only abuse control.
    return { allowed: false, remaining_day: 0, retry_after_s: 60 };
  }
}

export async function reserveCacheMiss(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const bucket = `g:${day}:miss`;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
         WHERE count < ?
       RETURNING count`,
    ).bind(
      bucket,
      new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
      GLOBAL_DAILY_CACHE_MISSES,
    ).run();
    const count = (result.results?.[0] as { count?: number } | undefined)?.count;
    return typeof count === "number" && count <= GLOBAL_DAILY_CACHE_MISSES;
  } catch {
    return false;
  }
}

export async function checkKeyIssuance(
  env: Env,
  caller: CallerIdentity,
): Promise<{ allowed: boolean; remaining: number }> {
  if (caller.internal) return { allowed: true, remaining: 999999 };
  if (caller.keyed) return { allowed: false, remaining: 0 };
  const day = new Date().toISOString().slice(0, 10);
  const bucket = `k:${day}:${caller.clientKey}`;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
         WHERE count < 2
       RETURNING count`,
    ).bind(bucket, new Date(Date.now() + 25 * 60 * 60_000).toISOString()).run();
    const count = (result.results?.[0] as { count?: number } | undefined)?.count;
    if (typeof count !== "number") return { allowed: false, remaining: 0 };
    return { allowed: true, remaining: Math.max(0, 2 - count) };
  } catch {
    return { allowed: false, remaining: 0 };
  }
}

export async function cleanupRateCounters(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `DELETE FROM rate_counters WHERE bucket IN (
         SELECT bucket FROM rate_counters WHERE expires_at < ? LIMIT 500
       )`,
    )
      .bind(new Date().toISOString())
      .run();
  } catch {
    /* best effort */
  }
}

export async function cleanupUsageEvents(env: Env): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 45 * 864e5).toISOString();
    // MCP funnel rows are retained so all-time and repeat-user milestones do
    // not silently reset. Generic REST usage remains a rolling diagnostic log.
    await env.DB.prepare(
      `DELETE FROM usage_events WHERE id IN (
         SELECT id FROM usage_events WHERE ts < ? ORDER BY id LIMIT 500
       )`,
    )
      .bind(cutoff)
      .run();
  } catch {
    /* best effort */
  }
}
