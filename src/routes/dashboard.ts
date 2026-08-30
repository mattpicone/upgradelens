// Owner dashboard: one screen answering "is this experiment working?"
// Auth: OWNER_TOKEN via Authorization: Bearer only (never place secrets in URLs).
// Business milestones use only successful, post-cutover, externally invoked
// UpgradeLens MCP tools after conservative verifier/test exclusions.

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import type { AppVariables } from "../context";
import { paymentActivation } from "../billing";

// Browser sign-in support: the owner pastes the token once and a scoped,
// HttpOnly cookie keeps that device signed in. The token never appears in a
// URL, and API/script access via Authorization: Bearer is unchanged.
const OWNER_COOKIE = "ul_owner";
const OWNER_COOKIE_MAX_AGE_S = 90 * 24 * 3600;

function loginPage(status: 200 | 401, message?: string) {
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>UpgradeLens — owner sign-in</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#E8DCC7;color:#30361f;font:16px/1.5 "Avenir Next",Avenir,"Trebuchet MS",sans-serif}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.025;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.8'/%3E%3C/svg%3E")}
form{position:relative;background:#D4B895;border:1px solid #B08B6E;border-radius:28px;padding:clamp(24px,7vw,40px);max-width:420px;width:100%}
h1{font-size:clamp(1.8rem,7vw,2.5rem);line-height:1.05;letter-spacing:-.04em;margin:0 0 8px}p{color:#606C38;font-size:.95rem;margin:0 0 24px}
input{width:100%;background:#E8DCC7;color:#30361f;border:1px solid #8B9D83;border-radius:18px;padding:15px 16px;font:inherit;margin-bottom:12px;outline:none}
input:focus{border-color:#C66B3D;box-shadow:0 0 0 3px rgba(198,107,61,.18)}
button{width:100%;background:#606C38;color:#E8DCC7;border:0;border-radius:18px;padding:15px 18px;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:#30361f}.err{color:#8b3625;font-size:.9rem;margin:0 0 12px}
</style></head><body>
<form method="post" action="/dashboard/login">
<h1>UpgradeLens</h1>
<p>Enter your owner token to view the dashboard. This device stays signed in for 90 days.</p>
${message ? `<p class="err">${message}</p>` : ""}
<input type="password" name="token" placeholder="Owner token" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form></body></html>`,
    status,
  ] as const;
}

function securityHeaders(c: { header: (name: string, value: string) => void }) {
  c.header("cache-control", "no-store, max-age=0");
  c.header("pragma", "no-cache");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex, nofollow");
}

export const dashboard = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Thresholds from the business spec (sections 27-30).
const THRESHOLDS = {
  minimum_days: 45,
  minimum: { calls: 25, clients: 3, repeat: 1 },
  promising: { calls30d: 100, clients: 10, active3days: 3 },
  strong: { calls30d: 1000, repeat: 20, positiveGrowthWeeks: 4, errorRate: 0.02, grossMargin: 0.75 },
  monetization: { calls30d: 500, repeat: 10 },
};

function utcWeekStart(date: Date): Date {
  const dayOffset = (date.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayOffset));
}

export interface Stats {
  overview: {
    totalCalls: number;
    revenue: number;
  };
  today: {
    attempts: number;
    unique: number;
    repeat: number;
    success: number;
    failed: number;
    service_errors: number;
    internal_calls: number;
  };
  total: { attempts: number; success: number; unique: number; repeat: number; firstTs: string | null };
  d30: {
    attempts: number;
    success: number;
    unique: number;
    failed: number;
    service_errors: number;
    active3days: number;
    repeat: number;
    keyed_unique: number;
    keyed_active3days: number;
    keyed_repeat: number;
  };
  daily: { day: string; calls: number }[];
  weeklyGrowth: {
    week: string;
    calls: number;
    previous_calls: number;
    growth_percent: number | null;
  }[];
  fourPositiveGrowthWeeks: boolean;
  byTool: { tool: string; calls: number }[];
  trafficByClass: {
    classification_version: number;
    traffic_class: string;
    event_kind: string;
    records: number;
    clients: number;
    known_tools: number;
    invoked: number;
    successes: number;
  }[];
  byToolClass: {
    tool: string;
    actor_class: string;
    invocation_state: string;
    records: number;
    successes: number;
  }[];
  byEvent: { event_kind: string; calls: number; clients: number }[];
  verificationAgents: { user_agent: string; events: number; tool_calls: number }[];
  topPackages: { package: string; calls: number }[];
  funnel: {
    discovery_events: number;
    discovery_clients: number;
    initialize_events: number;
    initialize_clients: number;
    tools_list_events: number;
    tools_list_clients: number;
    external_tools_call_requests: number;
    external_tools_call_clients: number;
    known_tool_invocations: number;
    known_tool_invocation_clients: number;
    successful_business_calls: number;
    genuine_tool_clients: number;
    repeat_genuine_tool_clients: number;
    genuine_keyed_clients: number;
    genuine_anonymous_identities: number;
    repeat_keyed_clients: number;
    repeat_anonymous_identities: number;
    registry_verification_events: number;
    auth_verification_events: number;
    crawler_monitor_events: number;
    verification_tool_calls: number;
    invalid_auth_events: number;
    legacy_unverifiable_events: number;
    first_discovery_ts: string | null;
  };
  countsResetAt: string | null;
  evaluationStartedAt: string | null;
  unknownRate: number;
  cacheHitRate: number;
  latency: { p50: number; p95: number; p99: number };
  revenue: number;
  fees: number;
  grossProfit: number;
  grossMargin: number | null;
}

// This is the only population allowed to influence business state. Protocol
// discovery, tools/list, unknown tool calls, owner tests, and self-identified
// registry/security/health verification are deliberately excluded.
const ELIGIBLE_TOOL_ATTEMPT_WHERE = `classification_version=1 AND external=1
  AND traffic_class='external' AND actor_class='external_tool_client'
  AND auth_state<>'invalid_key' AND owned_test=0 AND event_kind='tools_call'
  AND known_tool=1 AND tool_invoked=1`;
const GENUINE_TOOL_WHERE = `${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND tool_success=1`;

export async function collectStats(env: Env): Promise<Stats> {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const currentWeekStart = utcWeekStart(new Date());
  const fiveWeeksStart = new Date(currentWeekStart.getTime() - 5 * 7 * 864e5);

  const one = async <T>(sql: string, ...binds: unknown[]): Promise<T | null> =>
    (await db
      .prepare(sql)
      .bind(...binds)
      .first<T>()) ?? null;
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> =>
    ((await db.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[];

  // Keep all underlying telemetry for audit, but make every dashboard metric
  // relative to one immutable, recorded baseline. Older deployments may not
  // have the table yet; the epoch fallback preserves pre-reset behavior until
  // migration 0005 is applied.
  let countsResetAt: string | null = null;
  try {
    const reset = await one<{ counts_reset_at: string }>(
      `SELECT counts_reset_at FROM dashboard_state WHERE id=1`,
    );
    countsResetAt = reset?.counts_reset_at ?? null;
  } catch {
    // The schema migration is applied separately from code deployment.
  }
  const dashboardSince = countsResetAt ?? "0000-01-01T00:00:00.000Z";

  const overviewCalls = await one<{ total_calls: number }>(
    `SELECT COUNT(*) total_calls FROM mcp_events WHERE ts >= ?`,
    dashboardSince,
  );

  const todayRow = await one<{
    attempts: number;
    unique_c: number;
    success: number;
    failed: number;
    service_errors: number;
  }>(
    `SELECT COUNT(*) attempts,
       COUNT(DISTINCT CASE WHEN tool_success=1 THEN client_key END) unique_c,
       SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) success,
       SUM(CASE WHEN tool_success<>1 THEN 1 ELSE 0 END) failed,
       SUM(CASE WHEN error_kind IN ('service_error','server_error') THEN 1 ELSE 0 END) service_errors
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ? AND ts >= ?`,
    today,
    dashboardSince,
  );
  const internalToday = await one<{ calls: number }>(
    `SELECT COUNT(*) calls FROM mcp_events
     WHERE classification_version=1 AND actor_class='internal'
       AND event_kind='tools_call' AND known_tool=1 AND tool_invoked=1 AND ts >= ? AND ts >= ?`,
    today,
    dashboardSince,
  );
  const repeatToday = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
       INTERSECT
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts < ? AND ts >= ?
     )`,
    today,
    dashboardSince,
    today,
    dashboardSince,
  );
  const totalRow = await one<{
    attempts: number;
    success: number;
    unique_c: number;
    first_ts: string | null;
  }>(
    `SELECT COUNT(*) attempts,
       SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) success,
       COUNT(DISTINCT CASE WHEN tool_success=1 THEN client_key END) unique_c,
       MIN(CASE WHEN tool_success=1 THEN ts END) first_ts
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ?`,
    dashboardSince,
  );
  const repeatTotal = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    dashboardSince,
  );
  const d30Row = await one<{
    attempts: number;
    success: number;
    unique_c: number;
    failed: number;
    service_errors: number;
  }>(
    `SELECT COUNT(*) attempts,
       SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) success,
       COUNT(DISTINCT CASE WHEN tool_success=1 THEN client_key END) unique_c,
       SUM(CASE WHEN tool_success<>1 THEN 1 ELSE 0 END) failed,
       SUM(CASE WHEN error_kind IN ('service_error','server_error') THEN 1 ELSE 0 END) service_errors
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ? AND ts >= ?`,
    d30,
    dashboardSince,
  );
  const active3 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 3
     )`,
    d30,
    dashboardSince,
  );
  const keyedActive3 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
         AND client_key LIKE 'key:%'
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 3
     )`,
    d30,
    dashboardSince,
  );
  const repeat30 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    d30,
    dashboardSince,
  );
  const keyedRepeat30 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
         AND client_key LIKE 'key:%'
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    d30,
    dashboardSince,
  );
  const keyedUnique30 = await one<{ n: number }>(
    `SELECT COUNT(DISTINCT client_key) n FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ? AND client_key LIKE 'key:%'`,
    d30,
    dashboardSince,
  );
  const daily = await all<{ day: string; calls: number }>(
    `SELECT substr(ts,1,10) day, COUNT(*) calls FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ? GROUP BY day ORDER BY day`,
    d30,
    dashboardSince,
  );
  const weeklyRows = await all<{ week: string; calls: number }>(
    `SELECT strftime('%Y-%m-%d', ts,
       '-' || ((CAST(strftime('%w', ts) AS INTEGER) + 6) % 7) || ' days') week,
       COUNT(*) calls
     FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ? AND ts < ?
     GROUP BY week ORDER BY week`,
    fiveWeeksStart.toISOString(),
    dashboardSince,
    currentWeekStart.toISOString(),
  );
  const weeklyCounts = new Map(weeklyRows.map((row) => [row.week, row.calls]));
  const completedWeeks = Array.from({ length: 5 }, (_, index) => {
    const start = new Date(fiveWeeksStart.getTime() + index * 7 * 864e5);
    return start.toISOString().slice(0, 10);
  });
  const weeklyGrowth = completedWeeks.slice(1).map((week, index) => {
    const previous_calls = weeklyCounts.get(completedWeeks[index] ?? "") ?? 0;
    const calls = weeklyCounts.get(week) ?? 0;
    return {
      week,
      calls,
      previous_calls,
      growth_percent: previous_calls > 0 ? Math.round(((calls - previous_calls) / previous_calls) * 10000) / 100 : null,
    };
  });
  const fourPositiveGrowthWeeks =
    weeklyGrowth.length === THRESHOLDS.strong.positiveGrowthWeeks &&
    weeklyGrowth.every((week) => week.previous_calls > 0 && week.calls > week.previous_calls);
  const byTool = await all<{ tool: string; calls: number }>(
    `SELECT business_tool tool, COUNT(*) calls FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ?
     GROUP BY business_tool ORDER BY calls DESC LIMIT 12`,
    d30,
    dashboardSince,
  );
  const trafficByClass = await all<Stats["trafficByClass"][number]>(
    `SELECT classification_version, traffic_class, event_kind, COUNT(*) records,
       COUNT(DISTINCT client_key) clients,
       SUM(CASE WHEN known_tool=1 THEN 1 ELSE 0 END) known_tools,
       SUM(CASE WHEN tool_invoked=1 THEN 1 ELSE 0 END) invoked,
       SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) successes
     FROM mcp_events
     WHERE ts >= ?
     GROUP BY classification_version, traffic_class, event_kind
     ORDER BY classification_version, traffic_class, records DESC, event_kind`,
    dashboardSince,
  );
  const byToolClass = await all<{
    tool: string;
    actor_class: string;
    invocation_state: string;
    records: number;
    successes: number;
  }>(
    `SELECT COALESCE(business_tool,requested_tool,'(missing)') tool, actor_class,
       CASE WHEN tool_invoked=1 THEN 'invoked'
            WHEN tool_invoked=0 THEN 'not_invoked'
            ELSE 'legacy_unknown' END invocation_state,
       COUNT(*) records, SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) successes
     FROM mcp_events WHERE event_kind='tools_call' AND known_tool=1 AND ts >= ?
     GROUP BY tool, actor_class, invocation_state ORDER BY records DESC, tool LIMIT 30`,
    dashboardSince,
  );
  const topPackages = await all<{ package: string; calls: number }>(
    `SELECT package, COUNT(*) calls FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts >= ? AND package IS NOT NULL
     GROUP BY package ORDER BY calls DESC LIMIT 10`,
    d30,
    dashboardSince,
  );
  const funnel = await one<Stats["funnel"]>(
    `SELECT
       SUM(CASE WHEN event_kind<>'tools_call' THEN 1 ELSE 0 END) discovery_events,
       COUNT(DISTINCT CASE WHEN event_kind<>'tools_call' THEN client_key END) discovery_clients,
       SUM(CASE WHEN event_kind='initialize' AND traffic_class='external' THEN 1 ELSE 0 END) initialize_events,
       COUNT(DISTINCT CASE WHEN event_kind='initialize' AND traffic_class='external' THEN client_key END) initialize_clients,
       SUM(CASE WHEN event_kind='tools_list' AND traffic_class='external' THEN 1 ELSE 0 END) tools_list_events,
       COUNT(DISTINCT CASE WHEN event_kind='tools_list' AND traffic_class='external' THEN client_key END) tools_list_clients,
       SUM(CASE WHEN classification_version=1 AND event_kind='tools_call'
         AND traffic_class='external' AND auth_state<>'invalid_key' AND owned_test=0 THEN 1 ELSE 0 END)
         external_tools_call_requests,
       COUNT(DISTINCT CASE WHEN classification_version=1 AND event_kind='tools_call'
         AND traffic_class='external' AND auth_state<>'invalid_key' AND owned_test=0 THEN client_key END)
         external_tools_call_clients,
       SUM(CASE WHEN classification_version=1 AND event_kind='tools_call'
         AND traffic_class='external' AND auth_state<>'invalid_key' AND owned_test=0
         AND known_tool=1 AND tool_invoked=1 THEN 1 ELSE 0 END) known_tool_invocations,
       COUNT(DISTINCT CASE WHEN classification_version=1 AND event_kind='tools_call'
         AND traffic_class='external' AND auth_state<>'invalid_key' AND owned_test=0
         AND known_tool=1 AND tool_invoked=1 THEN client_key END) known_tool_invocation_clients,
       SUM(CASE WHEN ${GENUINE_TOOL_WHERE} THEN 1 ELSE 0 END) successful_business_calls,
       COUNT(DISTINCT CASE WHEN ${GENUINE_TOOL_WHERE} THEN client_key END) genuine_tool_clients,
       COUNT(DISTINCT CASE WHEN ${GENUINE_TOOL_WHERE} AND client_key LIKE 'key:%'
         THEN client_key END) genuine_keyed_clients,
       COUNT(DISTINCT CASE WHEN ${GENUINE_TOOL_WHERE} AND client_key NOT LIKE 'key:%'
         THEN client_key END) genuine_anonymous_identities,
       (SELECT COUNT(*) FROM (
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
          GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
        )) repeat_genuine_tool_clients,
       (SELECT COUNT(*) FROM (
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
            AND client_key LIKE 'key:%'
          GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
        )) repeat_keyed_clients,
       (SELECT COUNT(*) FROM (
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
            AND client_key NOT LIKE 'key:%'
          GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
        )) repeat_anonymous_identities,
       SUM(CASE WHEN verification_kind='registry' THEN 1 ELSE 0 END) registry_verification_events,
       SUM(CASE WHEN verification_kind='auth' THEN 1 ELSE 0 END) auth_verification_events,
       SUM(CASE WHEN actor_class='crawler_monitor' THEN 1 ELSE 0 END) crawler_monitor_events,
       SUM(CASE WHEN traffic_class='verification' AND event_kind='tools_call' THEN 1 ELSE 0 END) verification_tool_calls,
       SUM(CASE WHEN auth_state='invalid_key' THEN 1 ELSE 0 END) invalid_auth_events,
       SUM(CASE WHEN classification_version=0 THEN 1 ELSE 0 END) legacy_unverifiable_events,
       MIN(ts) first_discovery_ts
     FROM mcp_events WHERE external=1 AND ts >= ?`,
    dashboardSince,
    dashboardSince,
    dashboardSince,
    dashboardSince,
  );
  const byEvent = await all<{ event_kind: string; calls: number; clients: number }>(
    `SELECT event_kind, COUNT(*) calls, COUNT(DISTINCT client_key) clients
     FROM mcp_events WHERE external=1 AND ts >= ? AND ts >= ?
     GROUP BY event_kind ORDER BY calls DESC`,
    d30,
    dashboardSince,
  );
  const verificationAgents = await all<{
    user_agent: string;
    events: number;
    tool_calls: number;
  }>(
    `SELECT COALESCE(user_agent,'(empty)') user_agent, COUNT(*) events,
       SUM(CASE WHEN event_kind='tools_call' THEN 1 ELSE 0 END) tool_calls
     FROM mcp_events WHERE external=1 AND traffic_class='verification' AND ts >= ? AND ts >= ?
     GROUP BY user_agent ORDER BY events DESC LIMIT 12`,
    d30,
    dashboardSince,
  );
  const rates = await one<{ unknowns: number; hits: number; total: number }>(
    `SELECT SUM(unknown_result) unknowns, SUM(cache_hit) hits, COUNT(*) total
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ? AND ts >= ?`,
    d30,
    dashboardSince,
  );
  const lat = await all<{ latency_ms: number }>(
    `SELECT latency_ms FROM mcp_events
     WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ? AND ts >= ?
     ORDER BY ts DESC LIMIT 2000`,
    new Date(Date.now() - 864e5).toISOString(),
    dashboardSince,
  );
  lat.sort((a, b) => a.latency_ms - b.latency_ms);
  const pct = (p: number) =>
    lat.length === 0 ? 0 : (lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]?.latency_ms ?? 0);
  const ledger = await one<{ revenue: number; fees: number }>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_usd ELSE 0 END),0) revenue,
       COALESCE(SUM(CASE WHEN entry_type='fee' THEN amount_usd ELSE 0 END),0) fees
     FROM billing_ledger WHERE ts >= ? AND ts >= ?`,
    d30,
    dashboardSince,
  );
  const revenue = ledger?.revenue ?? 0;
  const fees = ledger?.fees ?? 0;
  const lifetimeLedger = await one<{ revenue: number }>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_usd ELSE 0 END),0) revenue
     FROM billing_ledger WHERE ts >= ?`,
    dashboardSince,
  );
  const experiment = await one<{ started_at: string }>(
    `SELECT started_at FROM experiments
     WHERE name='organic_mcp_validation' AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
  );

  return {
    overview: {
      totalCalls: overviewCalls?.total_calls ?? 0,
      revenue: lifetimeLedger?.revenue ?? 0,
    },
    today: {
      attempts: todayRow?.attempts ?? 0,
      unique: todayRow?.unique_c ?? 0,
      repeat: repeatToday?.n ?? 0,
      success: todayRow?.success ?? 0,
      failed: todayRow?.failed ?? 0,
      service_errors: todayRow?.service_errors ?? 0,
      internal_calls: internalToday?.calls ?? 0,
    },
    total: {
      attempts: totalRow?.attempts ?? 0,
      success: totalRow?.success ?? 0,
      unique: totalRow?.unique_c ?? 0,
      repeat: repeatTotal?.n ?? 0,
      firstTs: totalRow?.first_ts ?? null,
    },
    d30: {
      attempts: d30Row?.attempts ?? 0,
      success: d30Row?.success ?? 0,
      unique: d30Row?.unique_c ?? 0,
      failed: d30Row?.failed ?? 0,
      service_errors: d30Row?.service_errors ?? 0,
      active3days: active3?.n ?? 0,
      repeat: repeat30?.n ?? 0,
      keyed_unique: keyedUnique30?.n ?? 0,
      keyed_active3days: keyedActive3?.n ?? 0,
      keyed_repeat: keyedRepeat30?.n ?? 0,
    },
    daily,
    weeklyGrowth,
    fourPositiveGrowthWeeks,
    byTool,
    trafficByClass,
    byToolClass,
    byEvent,
    verificationAgents,
    topPackages,
    funnel: {
      discovery_events: funnel?.discovery_events ?? 0,
      discovery_clients: funnel?.discovery_clients ?? 0,
      initialize_events: funnel?.initialize_events ?? 0,
      initialize_clients: funnel?.initialize_clients ?? 0,
      tools_list_events: funnel?.tools_list_events ?? 0,
      tools_list_clients: funnel?.tools_list_clients ?? 0,
      external_tools_call_requests: funnel?.external_tools_call_requests ?? 0,
      external_tools_call_clients: funnel?.external_tools_call_clients ?? 0,
      known_tool_invocations: funnel?.known_tool_invocations ?? 0,
      known_tool_invocation_clients: funnel?.known_tool_invocation_clients ?? 0,
      successful_business_calls: funnel?.successful_business_calls ?? 0,
      genuine_tool_clients: funnel?.genuine_tool_clients ?? 0,
      repeat_genuine_tool_clients: funnel?.repeat_genuine_tool_clients ?? 0,
      genuine_keyed_clients: funnel?.genuine_keyed_clients ?? 0,
      genuine_anonymous_identities: funnel?.genuine_anonymous_identities ?? 0,
      repeat_keyed_clients: funnel?.repeat_keyed_clients ?? 0,
      repeat_anonymous_identities: funnel?.repeat_anonymous_identities ?? 0,
      registry_verification_events: funnel?.registry_verification_events ?? 0,
      auth_verification_events: funnel?.auth_verification_events ?? 0,
      crawler_monitor_events: funnel?.crawler_monitor_events ?? 0,
      verification_tool_calls: funnel?.verification_tool_calls ?? 0,
      invalid_auth_events: funnel?.invalid_auth_events ?? 0,
      legacy_unverifiable_events: funnel?.legacy_unverifiable_events ?? 0,
      first_discovery_ts: funnel?.first_discovery_ts ?? null,
    },
    // A requested reset starts a fresh measurement clock as well as zeroing
    // the visible aggregates; the old experiment row remains audit history.
    evaluationStartedAt: countsResetAt ?? experiment?.started_at ?? null,
    unknownRate: rates && rates.total > 0 ? (rates.unknowns ?? 0) / rates.total : 0,
    cacheHitRate: rates && rates.total > 0 ? (rates.hits ?? 0) / rates.total : 0,
    latency: { p50: pct(50), p95: pct(95), p99: pct(99) },
    revenue,
    fees,
    grossProfit: revenue - fees,
    // Margin is deliberately undefined while all usage is free. Reporting a
    // zero margin here would falsely satisfy a paid-economics gate.
    grossMargin: revenue > 0 ? (revenue - fees) / revenue : null,
    countsResetAt,
  };
}

export function businessState(s: Stats): { state: string; why: string } {
  const daysLive = s.evaluationStartedAt
    ? Math.floor((Date.now() - new Date(s.evaluationStartedAt).getTime()) / 864e5)
    : 0;
  const errRate = s.d30.attempts > 0 ? s.d30.service_errors / s.d30.attempts : 0;
  if (
    s.d30.success >= THRESHOLDS.strong.calls30d &&
    s.d30.keyed_repeat >= THRESHOLDS.strong.repeat &&
    errRate < THRESHOLDS.strong.errorRate &&
    s.fourPositiveGrowthWeeks &&
    s.grossMargin !== null &&
    s.grossMargin > THRESHOLDS.strong.grossMargin
  ) {
    return {
      state: "STRONG SIGNAL",
      why: `${s.d30.success} successful external calls in 30d, ${s.d30.keyed_repeat} repeat stable keyed clients, four consecutive positive-growth weeks, ${(errRate * 100).toFixed(1)}% service error rate, and ${(s.grossMargin * 100).toFixed(1)}% gross margin.`,
    };
  }
  if (
    s.d30.success >= THRESHOLDS.monetization.calls30d &&
    s.d30.keyed_repeat >= THRESHOLDS.monetization.repeat
  ) {
    return {
      state: "MONETIZATION TEST ELIGIBLE",
      why: `${s.d30.success} successful external calls in 30d and ${s.d30.keyed_repeat} repeat stable keyed clients meet the free-to-paid experiment trigger (≥500 calls and ≥10 repeat clients). Payment activation remains blocked pending the payment implementation and explicit pilot consent.`,
    };
  }
  if (
    s.d30.success >= THRESHOLDS.promising.calls30d &&
    s.d30.keyed_unique >= THRESHOLDS.promising.clients &&
    s.d30.keyed_active3days >= THRESHOLDS.promising.active3days
  ) {
    return {
      state: "PROMISING",
      why: `${s.d30.success} successful external calls in 30d from ${s.d30.keyed_unique} stable keyed clients; ${s.d30.keyed_active3days} keyed clients active on 3+ days.`,
    };
  }
  if (
    s.total.success >= THRESHOLDS.minimum.calls &&
    s.funnel.genuine_keyed_clients >= THRESHOLDS.minimum.clients &&
    s.funnel.repeat_keyed_clients >= THRESHOLDS.minimum.repeat
  ) {
    return {
      state: "EARLY SIGNAL",
      why: `${s.total.success} successful external calls include ${s.funnel.genuine_keyed_clients} stable keyed clients (${s.funnel.repeat_keyed_clients} repeat). Meets minimum continuation criteria.`,
    };
  }
  if (s.total.success > 0 && s.total.repeat > 0) {
    if (s.funnel.repeat_keyed_clients === 0) {
      return {
        state: "REPEAT ANONYMOUS TOOL IDENTITY OBSERVED",
        why: `${s.total.success} successful organic external business-tool calls from ${s.total.unique} privacy-preserving identities; ${s.total.repeat} anonymous/IP-derived identity returned on a separate UTC day. This is retention evidence, but not proof of one human or organization.`,
      };
    }
    return {
      state: "REPEAT ORGANIC TOOL USER CONFIRMED",
      why: `${s.total.success} successful organic external business-tool calls from ${s.total.unique} privacy-preserving identities; ${s.funnel.repeat_keyed_clients} stable keyed client returned on a separate UTC day.`,
    };
  }
  if (s.total.success > 0) {
    if (s.funnel.genuine_keyed_clients === 0) {
      return {
        state: "CANDIDATE ORGANIC CALL OBSERVED",
        why: `${s.total.success} successful external business-tool call came from an anonymous/IP-derived identity with no verifier signal. Treat it as a candidate organic call pending repeat or stronger identity evidence.`,
      };
    }
    return {
      state: "FIRST ORGANIC CALL CONFIRMED — WAITING FOR REPEAT USER",
      why: `${s.total.success} successful organic external business-tool calls include a stable keyed client. No keyed client has returned on a separate UTC day yet.`,
    };
  }
  if (daysLive > THRESHOLDS.minimum_days) {
    return {
      state: "KILL / PIVOT",
      why: `${daysLive} days since the clean telemetry cutover but minimum continuation criteria remain unmet (${s.total.success} successful organic calls, ${s.total.unique} clients, ${s.total.repeat} repeat). Per kill criteria, freeze or reposition.`,
    };
  }
  return {
    state: "WAITING FOR FIRST ORGANIC TOOL CALL",
    why: `${s.funnel.discovery_events} external discovery/protocol events from ${s.funnel.discovery_clients} privacy-preserving identities, but 0 successful organic external UpgradeLens business-tool calls since the clean telemetry cutover (day ${daysLive} of ${THRESHOLDS.minimum_days}).`,
  };
}

dashboard.post("/login", async (c) => {
  securityHeaders(c);
  if (!c.env.OWNER_TOKEN) {
    return c.text("Dashboard unavailable: OWNER_TOKEN secret is not configured.", 503);
  }
  const body = await c.req.parseBody();
  const submitted = typeof body.token === "string" ? body.token.trim() : "";
  if (submitted !== c.env.OWNER_TOKEN) {
    const [html, status] = loginPage(401, "That token didn't match. Try again.");
    return c.html(html, status);
  }
  setCookie(c, OWNER_COOKIE, submitted, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/dashboard",
    maxAge: OWNER_COOKIE_MAX_AGE_S,
  });
  return c.redirect("/dashboard", 303);
});

dashboard.post("/logout", (c) => {
  securityHeaders(c);
  deleteCookie(c, OWNER_COOKIE, { path: "/dashboard" });
  return c.redirect("/dashboard", 303);
});

dashboard.get("/", async (c) => {
  securityHeaders(c);
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const token = bearer || getCookie(c, OWNER_COOKIE) || "";
  if (!c.env.OWNER_TOKEN) {
    return c.text("Dashboard unavailable: OWNER_TOKEN secret is not configured.", 503);
  }
  if (token !== c.env.OWNER_TOKEN) {
    if (c.req.query("format") === "json") {
      return c.text("Unauthorized. Send OWNER_TOKEN as an Authorization: Bearer header.", 401);
    }
    const [html, status] = loginPage(401);
    return c.html(html, status);
  }

  const s = await collectStats(c.env);
  const activation = paymentActivation(c.env);
  const { state, why } = businessState(s);
  const errRateToday =
    s.today.attempts > 0 ? ((s.today.failed / s.today.attempts) * 100).toFixed(1) : "0.0";
  const serviceErrRateToday =
    s.today.attempts > 0
      ? ((s.today.service_errors / s.today.attempts) * 100).toFixed(1)
      : "0.0";

  if (c.req.query("format") === "json") {
    return c.json({
      generated_at: new Date().toISOString(),
      counts_reset_at: s.countsResetAt,
      counts_reset_scope: "All dashboard aggregates below include only telemetry and ledger rows at or after counts_reset_at; prior rows are retained for audit.",
      business_state: { state, why },
      definition: {
        genuine_business_tool_call:
          "post-cutover + external + non-verification + valid/anonymous auth + not owned-test + MCP tools/call + exact UpgradeLens tool + handler invoked + semantic success",
        genuine_external_tools_call:
          "post-cutover MCP tools/call from an external, non-verification, non-owned, non-invalid-auth source; the requested tool may still be unknown",
        actual_upgradelens_tool_invoked:
          "genuine external tools/call whose requested name exactly matches one of the three tools and whose handler was entered",
        genuine_tool_client:
          "distinct privacy-preserving client_key identity proxy with a genuine business-tool call; key: identities are stable, anon: identities are IP-derived",
        repeat_genuine_tool_client:
          "identity proxy with successful genuine calls on at least two distinct UTC days; anonymous repeats are reported separately and do not prove one human",
        limitation:
          "Anonymous intent cannot be mathematically proven; confirmed organic means no controlled-test marker and no stored registry, auth, crawler, scanner, audit, research, or monitor signal.",
      },
      stats: s,
      payment_activation: activation,
    });
  }

  const spark = (() => {
    if (s.daily.length === 0) return "<em>no external traffic yet</em>";
    const max = Math.max(...s.daily.map((d) => d.calls), 1);
    const w = 8;
    const bars = s.daily
      .map(
        (d, i) =>
          `<rect x="${i * w}" y="${40 - (d.calls / max) * 38}" width="${w - 2}" height="${(d.calls / max) * 38}" fill="#5eead4"><title>${d.day}: ${d.calls}</title></rect>`,
      )
      .join("");
    return `<svg width="${s.daily.length * w}" height="42" style="display:block">${bars}</svg>`;
  })();

  const esc = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const rows = (items: { [k: string]: unknown }[], cols: string[]) =>
    items.length === 0
      ? `<tr><td colspan="${cols.length}" class="muted">none yet</td></tr>`
      : items
          .map((r) => `<tr>${cols.map((col) => `<td>${esc(r[col])}</td>`).join("")}</tr>`)
          .join("");

  const daysLive = s.evaluationStartedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(s.evaluationStartedAt).getTime()) / 864e5))
    : 0;
  const verdicts: Record<string, { title: string; summary: string; next: string; color: string }> = {
    "WAITING FOR FIRST ORGANIC TOOL CALL": {
      title: "Waiting for real users",
      summary: `${s.overview.totalCalls} calls have reached UpgradeLens, but none were successful real-user calls yet.`,
      next: "Leave it running. The next milestone is one good call.",
      color: "#C08E3A",
    },
    "CANDIDATE ORGANIC CALL OBSERVED": {
      title: "A real user may have shown up",
      summary: "UpgradeLens received its first possible real-user call. A repeat visit will make the signal stronger.",
      next: "Keep watching for another good call from the same user.",
      color: "#C08E3A",
    },
    "FIRST ORGANIC CALL CONFIRMED — WAITING FOR REPEAT USER": {
      title: "A real user showed up",
      summary: "UpgradeLens completed a successful call for a real user. Now it needs someone to come back.",
      next: "Keep it running and watch for a returning user.",
      color: "#8B9D83",
    },
    "REPEAT ANONYMOUS TOOL IDENTITY OBSERVED": {
      title: "Someone may have come back",
      summary: "The same anonymous identity used UpgradeLens successfully on more than one day.",
      next: "Keep watching for more repeat use.",
      color: "#8B9D83",
    },
    "REPEAT ORGANIC TOOL USER CONFIRMED": {
      title: "Someone came back",
      summary: "A real user returned and used UpgradeLens successfully again.",
      next: "Keep growing repeat use.",
      color: "#606C38",
    },
    "EARLY SIGNAL": {
      title: "Early traction",
      summary: "UpgradeLens has enough real use to justify continuing the experiment.",
      next: "Keep improving distribution and watch repeat use.",
      color: "#606C38",
    },
    PROMISING: {
      title: "This is gaining traction",
      summary: "Real users are using UpgradeLens often enough to call the experiment promising.",
      next: "Keep the product stable and focus on reaching more users.",
      color: "#606C38",
    },
    "STRONG SIGNAL": {
      title: "It is working",
      summary: "Usage, repeat activity, reliability, and economics all show a strong signal.",
      next: "Keep scaling what is already working.",
      color: "#606C38",
    },
    "MONETIZATION TEST ELIGIBLE": {
      title: "Ready to test revenue",
      summary: "Usage is strong enough to consider a controlled payment test.",
      next: "Plan a small payment pilot before enabling billing.",
      color: "#606C38",
    },
    "VALIDATED PAID USAGE": {
      title: "Paid usage is working",
      summary: "Customers are paying and the product economics are healthy.",
      next: "Keep scaling carefully.",
      color: "#606C38",
    },
    "KILL / PIVOT": {
      title: "Time to rethink it",
      summary: "The experiment has run long enough without enough real usage.",
      next: "Change distribution or reposition the product before building more.",
      color: "#C66B3D",
    },
  };
  const verdict = verdicts[state] ?? {
    title: "Keep watching",
    summary: why,
    next: "Check back after more usage arrives.",
    color: "#8B9D83",
  };
  const number = new Intl.NumberFormat("en-US");
  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const earlySignalProgress = Math.min(100, (s.total.success / THRESHOLDS.minimum.calls) * 100);
  const lastUpdated = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date());

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>UpgradeLens — owner dashboard</title>
<style>
*{box-sizing:border-box}
:root{--sand:#E8DCC7;--oat:#D4B895;--sage:#8B9D83;--clay:#B08B6E;--terracotta:#C66B3D;--ochre:#C08E3A;--moss:#606C38;--ink:#30361f}
html{background:var(--sand)}
body{margin:0;min-height:100vh;background:var(--sand);color:var(--ink);font:16px/1.5 "Avenir Next",Avenir,"Trebuchet MS",sans-serif;padding:clamp(18px,4vw,48px)}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.025;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.8'/%3E%3C/svg%3E")}
button,summary{font:inherit}button:focus-visible,summary:focus-visible{outline:3px solid var(--terracotta);outline-offset:3px}.shell{position:relative;max-width:1080px;margin:0 auto}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:0 0 clamp(24px,5vw,52px)}
.brand{margin:0;font-size:clamp(1.35rem,4vw,1.85rem);letter-spacing:-.035em}.brand span{display:block;color:var(--moss);font-size:.82rem;font-weight:500;letter-spacing:0;margin-top:3px}
.updated{margin:0;color:var(--moss);font-size:.82rem;text-align:right;white-space:nowrap}
.verdict{position:relative;overflow:hidden;background:var(--oat);border:1px solid var(--clay);border-radius:32px;padding:clamp(24px,6vw,58px);margin-bottom:18px}
.verdict:after{content:"";position:absolute;width:190px;height:190px;border:34px solid ${verdict.color};border-radius:50%;right:-80px;top:-92px;opacity:.23;animation:breathe 4s ease-in-out infinite}
.eyebrow{display:flex;align-items:center;gap:10px;color:var(--moss);font-size:.88rem;font-weight:700;margin:0 0 16px}.signal{width:12px;height:12px;border-radius:50%;background:${verdict.color};flex:0 0 auto}
.verdict h1{position:relative;max-width:760px;font-size:clamp(2.45rem,8vw,6rem);line-height:.94;letter-spacing:-.065em;margin:0 0 24px}
.verdict-copy{position:relative;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,.75fr);gap:clamp(20px,5vw,64px);align-items:end}
.verdict-copy p{margin:0;font-size:clamp(1rem,2.3vw,1.24rem);max-width:620px}.next{border-left:2px solid ${verdict.color};padding-left:16px;color:var(--moss);font-size:.94rem}
.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:18px 0}
.metric{min-height:190px;display:flex;flex-direction:column;justify-content:space-between;background:rgba(212,184,149,.56);border:1px solid var(--clay);border-radius:28px;padding:24px}
.metric-label{color:var(--moss);font-size:.95rem;font-weight:700}.metric-value{font-size:clamp(3rem,7vw,5.5rem);line-height:.9;letter-spacing:-.07em;font-variant-numeric:tabular-nums;margin:26px 0 18px}.metric-help{color:var(--moss);font-size:.82rem;margin:0;max-width:220px}
.checkpoint{display:grid;grid-template-columns:minmax(170px,.55fr) minmax(0,1fr);gap:28px;align-items:center;background:var(--sage);border-radius:28px;padding:24px;margin:18px 0 28px;color:var(--ink)}
.checkpoint p{margin:0}.checkpoint strong{display:block;font-size:1.2rem;letter-spacing:-.02em;margin-top:3px}.progress{height:12px;background:rgba(232,220,199,.55);border-radius:999px;overflow:hidden}.progress span{display:block;height:100%;width:${earlySignalProgress}%;background:var(--moss);border-radius:inherit;transition:width 450ms ease}.progress-copy{display:flex;justify-content:space-between;gap:12px;font-size:.8rem;margin-top:8px;color:var(--ink)}
details{background:rgba(212,184,149,.34);border:1px solid var(--clay);border-radius:28px;margin-top:18px;overflow:hidden}summary{cursor:pointer;list-style-position:inside;padding:20px 24px;font-weight:700;color:var(--ink)}summary:hover{background:rgba(212,184,149,.45)}
.details-body{border-top:1px solid var(--clay);padding:8px 24px 28px}h2{font-size:1.25rem;letter-spacing:-.025em;margin:30px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:12px 0}.kpi{background:rgba(232,220,199,.62);border-radius:18px;padding:15px}.kpi b{display:block;font-size:1.45rem;font-variant-numeric:tabular-nums}.kpi span{color:var(--moss);font-size:.78rem}
.spark{max-width:100%;overflow-x:auto;padding:8px 0}.table-wrap{width:100%;overflow-x:auto;margin:10px 0 22px}table{border-collapse:collapse;width:100%;min-width:560px}td,th{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--clay);font-size:.82rem;vertical-align:top}th{color:var(--moss)}.muted{color:var(--moss)}.ok{color:var(--moss)}.warn{color:var(--terracotta)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em}
.footer{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:24px 0 8px;color:var(--moss);font-size:.78rem}.signout{background:transparent;border:1px solid var(--clay);color:var(--moss);border-radius:16px;padding:10px 14px;cursor:pointer}.signout:hover{border-color:var(--moss);color:var(--ink)}
@keyframes breathe{0%,100%{transform:scale(.96)}50%{transform:scale(1.04)}}
@media (prefers-reduced-motion:reduce){.verdict:after{animation:none}.progress span{transition:none}}
@media (max-width:720px){body{padding:18px}.topbar{align-items:flex-start}.updated{font-size:.74rem}.verdict{border-radius:26px}.verdict:after{width:130px;height:130px;border-width:24px;right:-58px;top:-58px}.verdict-copy{grid-template-columns:1fr}.next{max-width:420px}.metric-grid{grid-template-columns:1fr;gap:12px}.metric{min-height:150px;border-radius:24px}.metric-value{margin:18px 0 12px}.checkpoint{grid-template-columns:1fr;gap:18px;border-radius:24px}.details-body{padding:4px 16px 22px}summary{padding:18px}.footer{align-items:flex-start;flex-direction:column-reverse}}
</style></head><body>
<main class="shell">
<header class="topbar">
  <p class="brand">UpgradeLens<span>Owner dashboard</span></p>
  <p class="updated">Updated ${lastUpdated}</p>
</header>

<section class="verdict" aria-labelledby="verdict-title">
  <p class="eyebrow"><span class="signal" aria-hidden="true"></span>Day ${daysLive} of the experiment</p>
  <h1 id="verdict-title">${verdict.title}</h1>
  <div class="verdict-copy">
    <p>${verdict.summary}</p>
    <p class="next"><strong>What to do now</strong><br>${verdict.next}</p>
  </div>
</section>

<section class="metric-grid" aria-label="Key numbers since tracking started">
  <article class="metric">
    <span class="metric-label">All calls</span>
    <strong class="metric-value">${number.format(s.overview.totalCalls)}</strong>
    <p class="metric-help">Every MCP request recorded, including checks and bots.</p>
  </article>
  <article class="metric">
    <span class="metric-label">Good calls</span>
    <strong class="metric-value">${number.format(s.total.success)}</strong>
    <p class="metric-help">Successful use by real users. Owner tests are excluded.</p>
  </article>
  <article class="metric">
    <span class="metric-label">Money made</span>
    <strong class="metric-value">${currency.format(s.overview.revenue)}</strong>
    <p class="metric-help">Revenue collected since tracking started.</p>
  </article>
</section>

<section class="checkpoint" aria-label="Next checkpoint">
  <p>Next checkpoint<strong>${s.total.success === 0 ? "First good call" : "Early signal"}</strong></p>
  <div>
    <div class="progress" role="progressbar" aria-label="Good calls toward early signal" aria-valuemin="0" aria-valuemax="${THRESHOLDS.minimum.calls}" aria-valuenow="${Math.min(s.total.success, THRESHOLDS.minimum.calls)}"><span></span></div>
    <div class="progress-copy"><span>${number.format(s.total.success)} good calls</span><span>${THRESHOLDS.minimum.calls} needed for early signal</span></div>
  </div>
</section>

<details>
  <summary>View details</summary>
  <div class="details-body">
    <h2>Today</h2>
    <div class="grid">
      <div class="kpi"><b>${s.today.success}</b><span>good calls</span></div>
      <div class="kpi"><b>${s.today.attempts}</b><span>real-user attempts</span></div>
      <div class="kpi"><b>${s.today.unique}</b><span>real users</span></div>
      <div class="kpi"><b>${s.today.repeat}</b><span>returning users</span></div>
      <div class="kpi"><b>${s.today.internal_calls}</b><span>owner/test calls excluded</span></div>
      <div class="kpi"><b>${errRateToday}%</b><span>unsuccessful result rate</span></div>
      <div class="kpi"><b>${serviceErrRateToday}%</b><span>service error rate</span></div>
    </div>

    <h2>Last 30 days</h2>
    <div class="spark">${spark}</div>
    <div class="grid">
      <div class="kpi"><b>${s.d30.success}</b><span>good calls</span></div>
      <div class="kpi"><b>${s.d30.attempts}</b><span>real-user attempts</span></div>
      <div class="kpi"><b>${s.d30.unique}</b><span>real users</span></div>
      <div class="kpi"><b>${s.d30.repeat}</b><span>returning users</span></div>
      <div class="kpi"><b>${s.d30.active3days}</b><span>users active on 3+ days</span></div>
      <div class="kpi"><b>${currency.format(s.revenue)}</b><span>revenue</span></div>
      <div class="kpi"><b>${currency.format(s.grossProfit)}</b><span>gross profit</span></div>
      <div class="kpi"><b>${s.grossMargin === null ? "n/a" : `${(s.grossMargin * 100).toFixed(1)}%`}</b><span>gross margin</span></div>
    </div>

    <h2>Traffic breakdown</h2>
    <div class="grid">
      <div class="kpi"><b>${s.funnel.discovery_events}</b><span>discovery and setup events</span></div>
      <div class="kpi"><b>${s.funnel.discovery_clients}</b><span>discovery identities</span></div>
      <div class="kpi"><b>${s.funnel.initialize_events}</b><span>client connections</span></div>
      <div class="kpi"><b>${s.funnel.tools_list_events}</b><span>tool-list requests</span></div>
      <div class="kpi"><b>${s.funnel.external_tools_call_requests}</b><span>real-user tool requests</span></div>
      <div class="kpi"><b>${s.funnel.known_tool_invocations}</b><span>UpgradeLens tools invoked</span></div>
      <div class="kpi"><b>${s.funnel.successful_business_calls}</b><span>successful real-user calls</span></div>
      <div class="kpi"><b>${s.funnel.genuine_tool_clients}</b><span>real users</span></div>
      <div class="kpi"><b>${s.funnel.repeat_genuine_tool_clients}</b><span>returning users</span></div>
      <div class="kpi"><b>${s.funnel.registry_verification_events}</b><span>registry checks excluded</span></div>
      <div class="kpi"><b>${s.funnel.crawler_monitor_events}</b><span>crawler and monitor events</span></div>
      <div class="kpi"><b>${s.funnel.verification_tool_calls}</b><span>verification calls excluded</span></div>
      <div class="kpi"><b>${s.funnel.invalid_auth_events}</b><span>invalid authentication checks</span></div>
      <div class="kpi"><b>${s.funnel.legacy_unverifiable_events}</b><span>older events excluded</span></div>
    </div>
    <div class="table-wrap"><table><tr><th>Event</th><th>Events in 30 days</th><th>Identities</th></tr>${rows(s.byEvent as never, ["event_kind", "calls", "clients"])}</table></div>
    <div class="table-wrap"><table><tr><th>Classification</th><th>Traffic class</th><th>Event</th><th>Records</th><th>Identities</th><th>Known tools</th><th>Invoked</th><th>Successful</th></tr>${rows(s.trafficByClass as never, ["classification_version", "traffic_class", "event_kind", "records", "clients", "known_tools", "invoked", "successes"])}</table></div>
    <div class="table-wrap"><table><tr><th>Verification source</th><th>Events</th><th>Tool calls</th></tr>${rows(s.verificationAgents as never, ["user_agent", "events", "tool_calls"])}</table></div>

    <h2>Product health</h2>
    <div class="grid">
      <div class="kpi"><b>${(s.cacheHitRate * 100).toFixed(0)}%</b><span>cache hit rate</span></div>
      <div class="kpi"><b>${(s.unknownRate * 100).toFixed(1)}%</b><span>unknown-result rate</span></div>
      <div class="kpi"><b>${s.latency.p50}ms</b><span>typical latency</span></div>
      <div class="kpi"><b>${s.latency.p95}ms</b><span>slow-call latency</span></div>
      <div class="kpi"><b>${s.latency.p99}ms</b><span>slowest-call latency</span></div>
    </div>
    <div class="table-wrap"><table><tr><th>Tool</th><th>Successful real-user calls</th></tr>${rows(s.byTool as never, ["tool", "calls"])}</table></div>
    <div class="table-wrap"><table><tr><th>Tool</th><th>Actor class</th><th>Invocation state</th><th>Records</th><th>Successful</th></tr>${rows(s.byToolClass as never, ["tool", "actor_class", "invocation_state", "records", "successes"])}</table></div>
    <div class="table-wrap"><table><tr><th>Package</th><th>Calls</th></tr>${rows(s.topPackages as never, ["package", "calls"])}</table></div>

    <h2>How the signal is calculated</h2>
    <p class="muted">The business signal counts only successful calls made by real external users after the tracking baseline. Owner tests, invalid authentication, old records, registries, crawlers, audits, scanners, research tools, health checks, setup requests, and tool-list requests are excluded. A returning user must succeed on at least two separate days.</p>
    <p class="muted">Internal status: <strong>${state}</strong>. ${why}</p>
    <p class="muted">Tracking started ${s.countsResetAt ?? "before a recorded baseline"}. Version ${c.env.SERVICE_VERSION}; analysis ${c.env.ANALYSIS_VERSION}. Payments: ${activation.requested ? "blocked" : "off"}.</p>
  </div>
</details>

<footer class="footer">
  <form method="post" action="/dashboard/logout"><button class="signout">Sign out</button></form>
  <span>Private owner view</span>
</footer>
</main></body></html>`);
});
