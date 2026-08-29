// Owner dashboard: one screen answering "is this experiment working?"
// Auth: OWNER_TOKEN via Authorization: Bearer only (never place secrets in URLs).
// Business milestones use only successful, post-cutover, externally invoked
// UpgradeLens MCP tools after conservative verifier/test exclusions.

import { Hono } from "hono";
import type { Env } from "../types";
import type { AppVariables } from "../context";
import { paymentActivation } from "../billing";

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
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ?`,
    today,
  );
  const internalToday = await one<{ calls: number }>(
    `SELECT COUNT(*) calls FROM mcp_events
     WHERE classification_version=1 AND actor_class='internal'
       AND event_kind='tools_call' AND known_tool=1 AND tool_invoked=1 AND ts >= ?`,
    today,
  );
  const repeatToday = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
       INTERSECT
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts < ?
     )`,
    today,
    today,
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
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE}`,
  );
  const repeatTotal = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE}
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
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
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ?`,
    d30,
  );
  const active3 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 3
     )`,
    d30,
  );
  const keyedActive3 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
         AND client_key LIKE 'key:%'
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 3
     )`,
    d30,
  );
  const repeat30 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    d30,
  );
  const keyedRepeat30 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
         AND client_key LIKE 'key:%'
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    d30,
  );
  const keyedUnique30 = await one<{ n: number }>(
    `SELECT COUNT(DISTINCT client_key) n FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND client_key LIKE 'key:%'`,
    d30,
  );
  const daily = await all<{ day: string; calls: number }>(
    `SELECT substr(ts,1,10) day, COUNT(*) calls FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? GROUP BY day ORDER BY day`,
    d30,
  );
  const weeklyRows = await all<{ week: string; calls: number }>(
    `SELECT strftime('%Y-%m-%d', ts,
       '-' || ((CAST(strftime('%w', ts) AS INTEGER) + 6) % 7) || ' days') week,
       COUNT(*) calls
     FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND ts < ?
     GROUP BY week ORDER BY week`,
    fiveWeeksStart.toISOString(),
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
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ?
     GROUP BY business_tool ORDER BY calls DESC LIMIT 12`,
    d30,
  );
  const trafficByClass = await all<Stats["trafficByClass"][number]>(
    `SELECT classification_version, traffic_class, event_kind, COUNT(*) records,
       COUNT(DISTINCT client_key) clients,
       SUM(CASE WHEN known_tool=1 THEN 1 ELSE 0 END) known_tools,
       SUM(CASE WHEN tool_invoked=1 THEN 1 ELSE 0 END) invoked,
       SUM(CASE WHEN tool_success=1 THEN 1 ELSE 0 END) successes
     FROM mcp_events
     GROUP BY classification_version, traffic_class, event_kind
     ORDER BY classification_version, traffic_class, records DESC, event_kind`,
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
     FROM mcp_events WHERE event_kind='tools_call' AND known_tool=1
     GROUP BY tool, actor_class, invocation_state ORDER BY records DESC, tool LIMIT 30`,
  );
  const topPackages = await all<{ package: string; calls: number }>(
    `SELECT package, COUNT(*) calls FROM mcp_events
     WHERE ${GENUINE_TOOL_WHERE} AND ts >= ? AND package IS NOT NULL
     GROUP BY package ORDER BY calls DESC LIMIT 10`,
    d30,
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
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE}
          GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
        )) repeat_genuine_tool_clients,
       (SELECT COUNT(*) FROM (
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE}
            AND client_key LIKE 'key:%'
          GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
        )) repeat_keyed_clients,
       (SELECT COUNT(*) FROM (
          SELECT client_key FROM mcp_events WHERE ${GENUINE_TOOL_WHERE}
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
     FROM mcp_events WHERE external=1`,
  );
  const byEvent = await all<{ event_kind: string; calls: number; clients: number }>(
    `SELECT event_kind, COUNT(*) calls, COUNT(DISTINCT client_key) clients
     FROM mcp_events WHERE external=1 AND ts >= ?
     GROUP BY event_kind ORDER BY calls DESC`,
    d30,
  );
  const verificationAgents = await all<{
    user_agent: string;
    events: number;
    tool_calls: number;
  }>(
    `SELECT COALESCE(user_agent,'(empty)') user_agent, COUNT(*) events,
       SUM(CASE WHEN event_kind='tools_call' THEN 1 ELSE 0 END) tool_calls
     FROM mcp_events WHERE external=1 AND traffic_class='verification' AND ts >= ?
     GROUP BY user_agent ORDER BY events DESC LIMIT 12`,
    d30,
  );
  const rates = await one<{ unknowns: number; hits: number; total: number }>(
    `SELECT SUM(unknown_result) unknowns, SUM(cache_hit) hits, COUNT(*) total
     FROM mcp_events WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ?`,
    d30,
  );
  const lat = await all<{ latency_ms: number }>(
    `SELECT latency_ms FROM mcp_events
     WHERE ${ELIGIBLE_TOOL_ATTEMPT_WHERE} AND ts >= ?
     ORDER BY ts DESC LIMIT 2000`,
    new Date(Date.now() - 864e5).toISOString(),
  );
  lat.sort((a, b) => a.latency_ms - b.latency_ms);
  const pct = (p: number) =>
    lat.length === 0 ? 0 : (lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]?.latency_ms ?? 0);
  const ledger = await one<{ revenue: number; fees: number }>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_usd ELSE 0 END),0) revenue,
       COALESCE(SUM(CASE WHEN entry_type='fee' THEN amount_usd ELSE 0 END),0) fees
     FROM billing_ledger WHERE ts >= ?`,
    d30,
  );
  const revenue = ledger?.revenue ?? 0;
  const fees = ledger?.fees ?? 0;
  const experiment = await one<{ started_at: string }>(
    `SELECT started_at FROM experiments
     WHERE name='organic_mcp_validation' AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
  );

  return {
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
    evaluationStartedAt: experiment?.started_at ?? null,
    unknownRate: rates && rates.total > 0 ? (rates.unknowns ?? 0) / rates.total : 0,
    cacheHitRate: rates && rates.total > 0 ? (rates.hits ?? 0) / rates.total : 0,
    latency: { p50: pct(50), p95: pct(95), p99: pct(99) },
    revenue,
    fees,
    grossProfit: revenue - fees,
    // Margin is deliberately undefined while all usage is free. Reporting a
    // zero margin here would falsely satisfy a paid-economics gate.
    grossMargin: revenue > 0 ? (revenue - fees) / revenue : null,
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

dashboard.get("/", async (c) => {
  c.header("cache-control", "no-store, max-age=0");
  c.header("pragma", "no-cache");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex, nofollow");
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const token = bearer;
  if (!c.env.OWNER_TOKEN) {
    return c.text("Dashboard unavailable: OWNER_TOKEN secret is not configured.", 503);
  }
  if (token !== c.env.OWNER_TOKEN) {
    return c.text("Unauthorized. Send OWNER_TOKEN as an Authorization: Bearer header.", 401);
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

  const stateColor =
    {
      "WAITING FOR FIRST ORGANIC TOOL CALL": "#8b93a7",
      "CANDIDATE ORGANIC CALL OBSERVED": "#fbbf24",
      "FIRST ORGANIC CALL CONFIRMED — WAITING FOR REPEAT USER": "#fbbf24",
      "REPEAT ANONYMOUS TOOL IDENTITY OBSERVED": "#5eead4",
      "REPEAT ORGANIC TOOL USER CONFIRMED": "#5eead4",
      "EARLY SIGNAL": "#fbbf24",
      PROMISING: "#5eead4",
      "STRONG SIGNAL": "#34d399",
      "MONETIZATION TEST ELIGIBLE": "#818cf8",
      "VALIDATED PAID USAGE": "#34d399",
      "KILL / PIVOT": "#f87171",
    }[state] ?? "#8b93a7";

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>UpgradeLens — owner dashboard</title>
<style>
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui;background:#0b0e14;color:#e6e9f0;padding:24px}
h1{font-size:1.4rem}h2{font-size:1rem;color:#8b93a7;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.state{display:inline-block;padding:8px 16px;border-radius:8px;font-weight:700;font-size:1.2rem;background:#131826;border:2px solid ${stateColor};color:${stateColor}}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:12px 0}
.kpi{background:#131826;border-radius:8px;padding:12px}.kpi b{display:block;font-size:1.5rem}.kpi span{color:#8b93a7;font-size:.8rem}
table{border-collapse:collapse;width:100%;max-width:640px}td,th{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid #232a3d;font-size:.85rem}
.muted{color:#8b93a7}.ok{color:#34d399}.warn{color:#fbbf24}
</style></head><body>
<h1>UpgradeLens — owner dashboard</h1>
<p><span class="state">${state}</span></p>
<p class="muted">${why}</p>
<p class="muted">Out-of-pocket spend: <b class="ok">$0.00</b> (hard constraint) · Revenue (30d): $${s.revenue.toFixed(2)} · Payment fees: $${s.fees.toFixed(2)} · Gross profit: $${s.grossProfit.toFixed(2)} · Gross margin: ${s.grossMargin === null ? "not yet measurable while free" : `${(s.grossMargin * 100).toFixed(1)}%`} · Mode: ${activation.requested ? "PAYMENT ACTIVATION BLOCKED" : "FREE VALIDATION"}</p>

<h2>Business signal — genuine external MCP tools/call only</h2>
<div class="grid">
<div class="kpi"><b>${s.today.success}</b><span>successful organic calls today</span></div>
<div class="kpi"><b>${s.today.attempts}</b><span>known external tool invocations today</span></div>
<div class="kpi"><b>${s.today.unique}</b><span>genuine clients today</span></div>
<div class="kpi"><b>${s.today.repeat}</b><span>returning clients today</span></div>
<div class="kpi"><b>${s.total.success}</b><span>successful organic calls since cutover</span></div>
<div class="kpi"><b>${errRateToday}%</b><span>semantic failure rate</span></div>
<div class="kpi"><b>${serviceErrRateToday}%</b><span>service error rate</span></div>
<div class="kpi"><b>${s.today.internal_calls}</b><span>owner/test tool calls excluded</span></div>
</div>

<h2>Genuine business-tool trends — last 30 days</h2>
${spark}
<div class="grid">
<div class="kpi"><b>${s.d30.success}</b><span>successful organic calls / 30d</span></div>
<div class="kpi"><b>${s.d30.attempts}</b><span>known external invocations / 30d</span></div>
<div class="kpi"><b>${s.d30.unique}</b><span>genuine clients / 30d</span></div>
<div class="kpi"><b>${s.d30.repeat}</b><span>repeat genuine clients / 30d</span></div>
<div class="kpi"><b>${s.d30.active3days}</b><span>genuine clients active 3+ days</span></div>
<div class="kpi"><b>${s.total.attempts}</b><span>known invocations since cutover</span></div>
<div class="kpi"><b>${s.total.unique}</b><span>genuine clients since cutover</span></div>
<div class="kpi"><b>${s.fourPositiveGrowthWeeks ? "yes" : "no"}</b><span>four completed weeks positive growth</span></div>
<div class="kpi"><b>${s.grossMargin === null ? "n/a" : `${(s.grossMargin * 100).toFixed(1)}%`}</b><span>gross margin (30d)</span></div>
</div>

<h2>Discovery → tool-call funnel (external; does not itself count as demand)</h2>
<div class="grid">
<div class="kpi"><b>${s.funnel.discovery_events}</b><span>discovery/protocol events</span></div>
<div class="kpi"><b>${s.funnel.discovery_clients}</b><span>discovery/protocol clients</span></div>
<div class="kpi"><b>${s.funnel.initialize_events}</b><span>non-verifier initialize events</span></div>
<div class="kpi"><b>${s.funnel.initialize_clients}</b><span>non-verifier initialize clients</span></div>
<div class="kpi"><b>${s.funnel.tools_list_events}</b><span>non-verifier tools/list events</span></div>
<div class="kpi"><b>${s.funnel.tools_list_clients}</b><span>non-verifier tools/list clients</span></div>
<div class="kpi"><b>${s.funnel.external_tools_call_requests}</b><span>genuine external tools/call requests</span></div>
<div class="kpi"><b>${s.funnel.external_tools_call_clients}</b><span>external tools/call clients</span></div>
<div class="kpi"><b>${s.funnel.known_tool_invocations}</b><span>actual UpgradeLens tools invoked</span></div>
<div class="kpi"><b>${s.funnel.known_tool_invocation_clients}</b><span>known-tool invocation clients</span></div>
<div class="kpi"><b>${s.funnel.successful_business_calls}</b><span>successful organic business calls</span></div>
<div class="kpi"><b>${s.funnel.genuine_tool_clients}</b><span>genuine tool clients</span></div>
<div class="kpi"><b>${s.funnel.repeat_genuine_tool_clients}</b><span>repeat genuine tool clients</span></div>
<div class="kpi"><b>${s.funnel.genuine_keyed_clients}</b><span>stable keyed genuine clients</span></div>
<div class="kpi"><b>${s.funnel.genuine_anonymous_identities}</b><span>anonymous/IP-derived identities</span></div>
<div class="kpi"><b>${s.funnel.repeat_keyed_clients}</b><span>repeat stable keyed clients</span></div>
<div class="kpi"><b>${s.funnel.repeat_anonymous_identities}</b><span>repeat anonymous identities</span></div>
<div class="kpi"><b>${s.funnel.registry_verification_events}</b><span>registry verification events</span></div>
<div class="kpi"><b>${s.funnel.auth_verification_events}</b><span>auth verification events</span></div>
<div class="kpi"><b>${s.funnel.crawler_monitor_events}</b><span>crawler/audit/monitor events</span></div>
<div class="kpi"><b>${s.funnel.verification_tool_calls}</b><span>verification tool calls excluded</span></div>
<div class="kpi"><b>${s.funnel.invalid_auth_events}</b><span>invalid-key/auth probes</span></div>
<div class="kpi"><b>${s.funnel.legacy_unverifiable_events}</b><span>legacy events excluded from business</span></div>
</div>
<table><tr><th>Protocol event kind</th><th>events (30d)</th><th>clients</th></tr>${rows(s.byEvent as never, ["event_kind", "calls", "clients"])}</table>
<h2>Conclusive traffic separation (retained history)</h2>
<table><tr><th>classification</th><th>traffic class</th><th>event kind</th><th>records</th><th>clients</th><th>known tools</th><th>handler invoked</th><th>semantic successes</th></tr>${rows(s.trafficByClass as never, ["classification_version", "traffic_class", "event_kind", "records", "clients", "known_tools", "invoked", "successes"])}</table>
<h2>Self-identified verification traffic (30d; excluded)</h2>
<table><tr><th>User agent</th><th>events</th><th>tool calls</th></tr>${rows(s.verificationAgents as never, ["user_agent", "events", "tool_calls"])}</table>

<h2>Product</h2>
<div class="grid">
<div class="kpi"><b>${(s.cacheHitRate * 100).toFixed(0)}%</b><span>cache hit rate</span></div>
<div class="kpi"><b>${(s.unknownRate * 100).toFixed(1)}%</b><span>unknown-result rate</span></div>
<div class="kpi"><b>${s.latency.p50}ms</b><span>p50 latency (24h)</span></div>
<div class="kpi"><b>${s.latency.p95}ms</b><span>p95 latency</span></div>
<div class="kpi"><b>${s.latency.p99}ms</b><span>p99 latency</span></div>
</div>
<table><tr><th>Actual UpgradeLens tool invoked</th><th>successful organic calls (30d)</th></tr>${rows(s.byTool as never, ["tool", "calls"])}</table>
<h2>Known tool requests by traffic class (retained history)</h2>
<table><tr><th>Tool</th><th>actor class</th><th>invocation state</th><th>records</th><th>semantic successes</th></tr>${rows(s.byToolClass as never, ["tool", "actor_class", "invocation_state", "records", "successes"])}</table>
<h2>Most requested packages (30d)</h2>
<table><tr><th>Package</th><th>calls</th></tr>${rows(s.topPackages as never, ["package", "calls"])}</table>

<h2>Thresholds (encoded)</h2>
<p class="muted">Business state counts only post-cutover, semantically successful external <code>tools/call</code> requests whose exact tool handler ran, after excluding owner/internal tests, invalid auth, legacy rows, and self-identified registry crawlers, audits, scanners, research collectors and health probes. <code>tools/list</code>, initialize, pings, transport checks, unknown tools and verification tool calls never count. A repeat client must succeed on at least two separate UTC days. Anonymous intent is not mathematically provable; “organic” is the conservative operational class with no stored controlled-test or verifier signal.
Strong signal requires ≥1,000 successful calls/30d, ≥20 stable keyed repeat clients, four completed weeks of positive week-over-week growth, &lt;2% service errors, and &gt;75% measurable gross margin. Monetization-test eligibility is a separate trigger at ≥500 successful calls/30d and ≥10 stable keyed repeat clients; payment activation remains blocked until the payment path is implemented, tested, and explicitly approved.</p>

<h2>System</h2>
<p class="muted">Version ${c.env.SERVICE_VERSION} · analysis v${c.env.ANALYSIS_VERSION} · generated ${new Date().toISOString()}</p>
</body></html>`);
});
