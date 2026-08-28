// Owner dashboard: one screen answering "is this experiment working?"
// Auth: OWNER_TOKEN via ?token= or Authorization: Bearer.
// All business metrics count EXTERNAL traffic only.

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
  strong: { calls30d: 1000, repeat: 20, errorRate: 0.02 },
  paidPilot: {
    calls30d: 1000,
    clients: 10,
    active3days: 5,
    repeat: 5,
    errorRate: 0.01,
    unknownRate: 0.05,
  },
};

interface Stats {
  today: {
    calls: number;
    unique: number;
    repeat: number;
    success: number;
    errors: number;
    internal_calls: number;
  };
  total: { calls: number; success: number; unique: number; repeat: number; firstTs: string | null };
  d30: { calls: number; success: number; unique: number; errors: number; active3days: number; repeat: number };
  daily: { day: string; calls: number }[];
  byTool: { tool: string; calls: number }[];
  topPackages: { package: string; calls: number }[];
  unknownRate: number;
  cacheHitRate: number;
  latency: { p50: number; p95: number; p99: number };
  revenue: number;
  fees: number;
}

async function collectStats(env: Env): Promise<Stats> {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 864e5).toISOString();

  const one = async <T>(sql: string, ...binds: unknown[]): Promise<T | null> =>
    (await db
      .prepare(sql)
      .bind(...binds)
      .first<T>()) ?? null;
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> =>
    ((await db.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[];

  const todayRow = await one<{
    calls: number;
    unique_c: number;
    success: number;
    errors: number;
  }>(
    `SELECT COUNT(*) calls, COUNT(DISTINCT client_key) unique_c,
       SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) success,
       SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) errors
     FROM usage_events WHERE external=1 AND ts >= ?`,
    today,
  );
  const internalToday = await one<{ calls: number }>(
    `SELECT COUNT(*) calls FROM usage_events WHERE external=0 AND ts >= ?`,
    today,
  );
  const repeatToday = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM usage_events WHERE external=1 AND ts >= ?
       INTERSECT
       SELECT client_key FROM usage_events WHERE external=1 AND ts < ?
     )`,
    today,
    today,
  );
  const totalRow = await one<{
    calls: number;
    success: number;
    unique_c: number;
    first_ts: string | null;
  }>(
    `SELECT COUNT(*) calls,
       SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) success,
       COUNT(DISTINCT client_key) unique_c, MIN(ts) first_ts
     FROM usage_events WHERE external=1`,
  );
  const repeatTotal = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM usage_events WHERE external=1
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
  );
  const d30Row = await one<{
    calls: number;
    success: number;
    unique_c: number;
    errors: number;
  }>(
    `SELECT COUNT(*) calls,
       SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) success,
       COUNT(DISTINCT client_key) unique_c,
       SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) errors
     FROM usage_events WHERE external=1 AND ts >= ?`,
    d30,
  );
  const active3 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM usage_events WHERE external=1 AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 3
     )`,
    d30,
  );
  const repeat30 = await one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT client_key FROM usage_events WHERE external=1 AND ts >= ?
       GROUP BY client_key HAVING COUNT(DISTINCT substr(ts,1,10)) >= 2
     )`,
    d30,
  );
  const daily = await all<{ day: string; calls: number }>(
    `SELECT substr(ts,1,10) day, COUNT(*) calls FROM usage_events
     WHERE external=1 AND ts >= ? GROUP BY day ORDER BY day`,
    d30,
  );
  const byTool = await all<{ tool: string; calls: number }>(
    `SELECT tool, COUNT(*) calls FROM usage_events
     WHERE external=1 AND ts >= ? GROUP BY tool ORDER BY calls DESC LIMIT 12`,
    d30,
  );
  const topPackages = await all<{ package: string; calls: number }>(
    `SELECT package, COUNT(*) calls FROM usage_events
     WHERE external=1 AND ts >= ? AND package IS NOT NULL
     GROUP BY package ORDER BY calls DESC LIMIT 10`,
    d30,
  );
  const rates = await one<{ unknowns: number; hits: number; total: number }>(
    `SELECT SUM(unknown_result) unknowns, SUM(cache_hit) hits, COUNT(*) total
     FROM usage_events WHERE ts >= ? AND surface IN ('rest','mcp')`,
    d30,
  );
  const lat = await all<{ latency_ms: number }>(
    `SELECT latency_ms FROM usage_events WHERE ts >= ? AND surface IN ('rest','mcp')
     ORDER BY latency_ms LIMIT 2000`,
    new Date(Date.now() - 864e5).toISOString(),
  );
  const pct = (p: number) =>
    lat.length === 0 ? 0 : (lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]?.latency_ms ?? 0);
  const ledger = await one<{ revenue: number; fees: number }>(
    `SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_usd ELSE 0 END),0) revenue,
       COALESCE(SUM(CASE WHEN entry_type='fee' THEN amount_usd ELSE 0 END),0) fees
     FROM billing_ledger`,
  );

  return {
    today: {
      calls: todayRow?.calls ?? 0,
      unique: todayRow?.unique_c ?? 0,
      repeat: repeatToday?.n ?? 0,
      success: todayRow?.success ?? 0,
      errors: todayRow?.errors ?? 0,
      internal_calls: internalToday?.calls ?? 0,
    },
    total: {
      calls: totalRow?.calls ?? 0,
      success: totalRow?.success ?? 0,
      unique: totalRow?.unique_c ?? 0,
      repeat: repeatTotal?.n ?? 0,
      firstTs: totalRow?.first_ts ?? null,
    },
    d30: {
      calls: d30Row?.calls ?? 0,
      success: d30Row?.success ?? 0,
      unique: d30Row?.unique_c ?? 0,
      errors: d30Row?.errors ?? 0,
      active3days: active3?.n ?? 0,
      repeat: repeat30?.n ?? 0,
    },
    daily,
    byTool,
    topPackages,
    unknownRate: rates && rates.total > 0 ? (rates.unknowns ?? 0) / rates.total : 0,
    cacheHitRate: rates && rates.total > 0 ? (rates.hits ?? 0) / rates.total : 0,
    latency: { p50: pct(50), p95: pct(95), p99: pct(99) },
    revenue: ledger?.revenue ?? 0,
    fees: ledger?.fees ?? 0,
  };
}

function businessState(
  s: Stats,
  activation: ReturnType<typeof paymentActivation>,
): { state: string; why: string } {
  const daysLive = s.total.firstTs
    ? Math.floor((Date.now() - new Date(s.total.firstTs).getTime()) / 864e5)
    : 0;
  const errRate = s.d30.calls > 0 ? s.d30.errors / s.d30.calls : 0;

  if (activation.requested && !activation.ready) {
    return {
      state: "PAYMENT ACTIVATION BLOCKED",
      why: activation.blockers.join("; "),
    };
  }
  if (
    s.d30.success >= THRESHOLDS.paidPilot.calls30d &&
    s.d30.unique >= THRESHOLDS.paidPilot.clients &&
    s.d30.active3days >= THRESHOLDS.paidPilot.active3days &&
    s.d30.repeat >= THRESHOLDS.paidPilot.repeat &&
    errRate < THRESHOLDS.paidPilot.errorRate &&
    s.unknownRate < THRESHOLDS.paidPilot.unknownRate
  ) {
    return {
      state: "PAID PILOT ELIGIBLE",
      why: "Reliability and retained-use gates are met. Require at least two explicit willing pilot clients before implementing or enabling payments.",
    };
  }
  if (
    s.d30.success >= THRESHOLDS.strong.calls30d &&
    s.d30.repeat >= THRESHOLDS.strong.repeat &&
    errRate < THRESHOLDS.strong.errorRate
  ) {
    return {
      state: "STRONG SIGNAL",
      why: `${s.d30.success} successful external calls in 30d, ${s.d30.repeat} repeat clients, ${(errRate * 100).toFixed(1)}% error rate.`,
    };
  }
  if (
    s.d30.success >= THRESHOLDS.promising.calls30d &&
    s.d30.unique >= THRESHOLDS.promising.clients &&
    s.d30.active3days >= THRESHOLDS.promising.active3days
  ) {
    return {
      state: "PROMISING",
      why: `${s.d30.success} successful external calls in 30d from ${s.d30.unique} clients; ${s.d30.active3days} clients active on 3+ days.`,
    };
  }
  if (
    s.total.success >= THRESHOLDS.minimum.calls &&
    s.total.unique >= THRESHOLDS.minimum.clients &&
    s.total.repeat >= THRESHOLDS.minimum.repeat
  ) {
    return {
      state: "EARLY SIGNAL",
      why: `${s.total.success} successful external calls from ${s.total.unique} clients (${s.total.repeat} repeat). Meets minimum continuation criteria.`,
    };
  }
  if (daysLive > THRESHOLDS.minimum_days) {
    return {
      state: "KILL / PIVOT",
      why: `${daysLive} days since first traffic but minimum continuation criteria unmet (${s.total.success} successful calls, ${s.total.unique} clients, ${s.total.repeat} repeat). Per kill criteria, freeze or reposition.`,
    };
  }
  return {
    state: "NO SIGNAL",
    why: `Only ${s.total.success} successful external calls from ${s.total.unique} unique clients so far (day ${daysLive} of ${THRESHOLDS.minimum_days}-day evaluation window).`,
  };
}

dashboard.get("/", async (c) => {
  const token = c.req.query("token") ?? (c.req.header("authorization")?.replace("Bearer ", "") ?? "");
  if (!c.env.OWNER_TOKEN) {
    return c.text("Dashboard unavailable: OWNER_TOKEN secret is not configured.", 503);
  }
  if (token !== c.env.OWNER_TOKEN) {
    return c.text("Unauthorized. Append ?token=<OWNER_TOKEN>.", 401);
  }

  const s = await collectStats(c.env);
  const activation = paymentActivation(c.env);
  const { state, why } = businessState(s, activation);
  const errRateToday = s.today.calls > 0 ? ((s.today.errors / s.today.calls) * 100).toFixed(1) : "0.0";

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

  const rows = (items: { [k: string]: unknown }[], cols: string[]) =>
    items.length === 0
      ? `<tr><td colspan="${cols.length}" class="muted">none yet</td></tr>`
      : items
          .map((r) => `<tr>${cols.map((col) => `<td>${String(r[col] ?? "")}</td>`).join("")}</tr>`)
          .join("");

  const stateColor =
    {
      "NO SIGNAL": "#8b93a7",
      "EARLY SIGNAL": "#fbbf24",
      PROMISING: "#5eead4",
      "STRONG SIGNAL": "#34d399",
      "MONETIZATION TESTING": "#818cf8",
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
<p class="muted">Out-of-pocket spend: <b class="ok">$0.00</b> (hard constraint) · Revenue: $${s.revenue.toFixed(2)} · Payment fees: $${s.fees.toFixed(2)} · Profit: $${(s.revenue - s.fees).toFixed(2)} · Mode: ${activation.requested ? "PAYMENT ACTIVATION BLOCKED" : "FREE VALIDATION"}</p>

<h2>Today (UTC) — external only</h2>
<div class="grid">
<div class="kpi"><b>${s.today.calls}</b><span>external calls</span></div>
<div class="kpi"><b>${s.today.unique}</b><span>unique callers</span></div>
<div class="kpi"><b>${s.today.repeat}</b><span>repeat callers</span></div>
<div class="kpi"><b>${s.today.success}</b><span>successful</span></div>
<div class="kpi"><b>${errRateToday}%</b><span>5xx error rate</span></div>
<div class="kpi"><b>${s.today.internal_calls}</b><span>internal calls (excluded)</span></div>
</div>

<h2>Trends — last 30 days</h2>
${spark}
<div class="grid">
<div class="kpi"><b>${s.d30.calls}</b><span>calls / 30d</span></div>
<div class="kpi"><b>${s.d30.unique}</b><span>unique clients / 30d</span></div>
<div class="kpi"><b>${s.d30.repeat}</b><span>repeat clients / 30d</span></div>
<div class="kpi"><b>${s.d30.active3days}</b><span>clients active 3+ days</span></div>
<div class="kpi"><b>${s.total.calls}</b><span>calls all-time</span></div>
<div class="kpi"><b>${s.total.unique}</b><span>clients all-time</span></div>
</div>

<h2>Product</h2>
<div class="grid">
<div class="kpi"><b>${(s.cacheHitRate * 100).toFixed(0)}%</b><span>cache hit rate</span></div>
<div class="kpi"><b>${(s.unknownRate * 100).toFixed(1)}%</b><span>unknown-result rate</span></div>
<div class="kpi"><b>${s.latency.p50}ms</b><span>p50 latency (24h)</span></div>
<div class="kpi"><b>${s.latency.p95}ms</b><span>p95 latency</span></div>
<div class="kpi"><b>${s.latency.p99}ms</b><span>p99 latency</span></div>
</div>
<table><tr><th>Tool / endpoint</th><th>calls (30d)</th></tr>${rows(s.byTool as never, ["tool", "calls"])}</table>
<h2>Most requested packages (30d)</h2>
<table><tr><th>Package</th><th>calls</th></tr>${rows(s.topPackages as never, ["package", "calls"])}</table>

<h2>Thresholds (encoded)</h2>
<p class="muted">Only completed REST/MCP analysis calls count; protocol handshakes and tool errors do not.
Paid-pilot eligibility: ≥1,000 successful calls/30d, ≥10 clients, ≥5 active on 3+ days, ≥5 repeat clients, &lt;1% errors, &lt;5% unknowns, plus two explicit willing pilots. Payments remain technically blocked until the payment path is implemented and tested.</p>

<h2>System</h2>
<p class="muted">Version ${c.env.SERVICE_VERSION} · analysis v${c.env.ANALYSIS_VERSION} · generated ${new Date().toISOString()}</p>
</body></html>`);
});
