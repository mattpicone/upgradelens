// Exercise the owner dashboard against SQLite rather than a query-shaped mock.
// Node 22 supplies the same SQLite dialect used by Cloudflare D1 for these
// aggregate queries, which makes classification leakage regressions visible.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { collectStats } from "../src/routes/dashboard.ts";

const SCHEMA = `
CREATE TABLE mcp_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  external INTEGER NOT NULL,
  traffic_class TEXT NOT NULL,
  actor_class TEXT NOT NULL,
  verification_kind TEXT NOT NULL,
  classification_reason TEXT NOT NULL,
  classification_version INTEGER NOT NULL,
  client_key TEXT NOT NULL,
  http_method TEXT NOT NULL,
  rpc_method TEXT,
  event_kind TEXT NOT NULL,
  requested_tool TEXT,
  business_tool TEXT,
  known_tool INTEGER NOT NULL DEFAULT 0,
  tool_invoked INTEGER,
  tool_success INTEGER,
  rpc_error_code INTEGER,
  error_kind TEXT,
  protocol_version TEXT,
  owned_test INTEGER NOT NULL DEFAULT 0,
  ecosystem TEXT,
  package TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  unknown_result INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'none',
  client_name TEXT,
  client_version TEXT,
  user_agent TEXT,
  referrer TEXT
);
CREATE TABLE billing_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  client_key TEXT NOT NULL,
  request_id TEXT,
  entry_type TEXT NOT NULL,
  amount_usd REAL NOT NULL
);
CREATE TABLE experiments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  variant TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metrics_json TEXT
);
CREATE TABLE dashboard_state (
  id INTEGER PRIMARY KEY,
  counts_reset_at TEXT NOT NULL,
  reset_reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  return {
    sqlite,
    d1: {
      prepare(sql) {
        let args = [];
        const statement = {
          bind(...values) {
            args = values;
            return statement;
          },
          first() {
            return sqlite.prepare(sql).get(...args) ?? null;
          },
          all() {
            return { results: sqlite.prepare(sql).all(...args) };
          },
        };
        return statement;
      },
    },
  };
}

function seedRow(sqlite, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(",");
  sqlite
    .prepare(`INSERT INTO mcp_events (${columns.join(",")}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column]));
}

describe("dashboard SQL classification boundaries", () => {
  it("keeps protocol, verification, legacy, internal, and genuine traffic separate", async () => {
    const { sqlite, d1 } = sqliteD1();
    const now = Date.now();
    const at = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
    const base = {
      external: 1,
      traffic_class: "external",
      actor_class: "unknown",
      verification_kind: "none",
      classification_reason: "fixture",
      classification_version: 1,
      client_key: "anon:fixture",
      http_method: "POST",
      event_kind: "protocol",
      known_tool: 0,
      tool_invoked: 0,
      tool_success: null,
      owned_test: 0,
      cache_hit: 0,
      status: 200,
      latency_ms: 10,
      unknown_result: 0,
      auth_state: "none",
    };
    const add = (id, overrides) =>
      seedRow(sqlite, {
        ...base,
        request_id: `fixture-${id}`,
        ts: at(1),
        ...overrides,
      });

    add(1, { ts: at(0), event_kind: "initialize", client_key: "anon:discovery" });
    add(2, { ts: at(0), event_kind: "tools_list", client_key: "anon:discovery" });
    add(3, {
      ts: at(0),
      traffic_class: "verification",
      actor_class: "registry_verifier",
      verification_kind: "registry",
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      client_key: "anon:registry",
    });
    add(4, {
      ts: at(0),
      traffic_class: "verification",
      actor_class: "auth_verifier",
      verification_kind: "auth",
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      auth_state: "invalid_key",
      client_key: "invalid:auth",
    });
    add(5, {
      ts: at(0),
      traffic_class: "verification",
      actor_class: "crawler_monitor",
      verification_kind: "crawler",
      event_kind: "tools_call",
      requested_tool: "plan_dependency_upgrade",
      business_tool: "plan_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 0,
      error_kind: "service_error",
      client_key: "anon:crawler",
      status: 500,
    });
    add(6, {
      ts: at(0),
      event_kind: "tools_call",
      requested_tool: "unknown_tool",
      client_key: "anon:unknown",
    });
    add(7, {
      ts: at(1),
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      actor_class: "external_tool_client",
      client_key: "key:client-a",
      ecosystem: "npm",
      package: "left-pad",
    });
    add(8, {
      ts: at(2),
      event_kind: "tools_call",
      requested_tool: "plan_dependency_upgrade",
      business_tool: "plan_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      actor_class: "external_tool_client",
      client_key: "key:client-a",
      ecosystem: "npm",
      package: "left-pad",
    });
    add(9, {
      ts: at(0),
      event_kind: "tools_call",
      requested_tool: "find_safe_upgrade_target",
      business_tool: "find_safe_upgrade_target",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      actor_class: "external_tool_client",
      client_key: "key:client-b",
      ecosystem: "pypi",
      package: "requests",
    });
    add(10, {
      ts: at(0),
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 0,
      actor_class: "external_tool_client",
      error_kind: "service_error",
      status: 500,
      client_key: "key:client-b",
    });
    add(11, {
      ts: at(10),
      classification_version: 0,
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: null,
      tool_success: null,
      client_key: "legacy:unknown",
    });
    add(12, {
      ts: at(0),
      external: 0,
      traffic_class: "internal",
      actor_class: "internal",
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      owned_test: 1,
      client_key: "owner",
    });
    sqlite
      .prepare("INSERT INTO experiments (name, variant, started_at) VALUES ('organic_mcp_validation','fixture',?)")
      .run(at(0));

    const stats = await collectStats({ DB: d1 });
    expect(stats.funnel).toMatchObject({
      initialize_events: 1,
      tools_list_events: 1,
      external_tools_call_requests: 5,
      known_tool_invocations: 4,
      successful_business_calls: 3,
      genuine_tool_clients: 2,
      repeat_genuine_tool_clients: 1,
      genuine_keyed_clients: 2,
      repeat_keyed_clients: 1,
      registry_verification_events: 1,
      auth_verification_events: 1,
      crawler_monitor_events: 1,
      verification_tool_calls: 3,
      invalid_auth_events: 1,
      legacy_unverifiable_events: 1,
    });
    expect(stats.d30).toMatchObject({ attempts: 4, success: 3, unique: 2, service_errors: 1 });
    expect(stats.overview).toMatchObject({ totalCalls: 12, revenue: 0 });
    expect(stats.byTool).toEqual(
      expect.arrayContaining([
        { tool: "check_dependency_upgrade", calls: 1 },
        { tool: "find_safe_upgrade_target", calls: 1 },
        { tool: "plan_dependency_upgrade", calls: 1 },
      ]),
    );
    expect(stats.trafficByClass).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification_version: 0, event_kind: "tools_call", records: 1 }),
        expect.objectContaining({ traffic_class: "verification", event_kind: "tools_call", records: 3 }),
        expect.objectContaining({ traffic_class: "internal", event_kind: "tools_call", records: 1 }),
      ]),
    );
    expect(stats.grossMargin).toBeNull();
    sqlite.close();
  });

  it("applies the recorded reset timestamp to every dashboard aggregate", async () => {
    const { sqlite, d1 } = sqliteD1();
    const now = Date.now();
    const at = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
    const resetAt = at(1);
    sqlite
      .prepare("INSERT INTO dashboard_state (id, counts_reset_at, reset_reason, updated_at) VALUES (1, ?, 'fixture', ?)")
      .run(resetAt, resetAt);
    const base = {
      external: 1,
      traffic_class: "external",
      actor_class: "external_tool_client",
      verification_kind: "none",
      classification_reason: "fixture",
      classification_version: 1,
      client_key: "key:reset-client",
      http_method: "POST",
      rpc_method: "tools/call",
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      owned_test: 0,
      ecosystem: "npm",
      package: "express",
      cache_hit: 0,
      status: 200,
      latency_ms: 10,
      unknown_result: 0,
      auth_state: "none",
    };
    seedRow(sqlite, { ...base, request_id: "old", ts: at(2) });
    seedRow(sqlite, { ...base, request_id: "fresh", ts: at(0) });
    seedRow(sqlite, {
      ...base,
      request_id: "fresh-init",
      ts: at(0),
      rpc_method: "initialize",
      event_kind: "initialize",
      requested_tool: null,
      business_tool: null,
      known_tool: 0,
      tool_invoked: 0,
      tool_success: null,
      actor_class: "unknown",
    });
    sqlite.prepare("INSERT INTO billing_ledger (ts, client_key, entry_type, amount_usd) VALUES (?, ?, 'credit', 1)").run(at(2), "key:reset-client");
    sqlite.prepare("INSERT INTO billing_ledger (ts, client_key, entry_type, amount_usd) VALUES (?, ?, 'credit', 2)").run(at(0), "key:reset-client");

    const stats = await collectStats({ DB: d1 });
    expect(stats.countsResetAt).toBe(resetAt);
    expect(stats.evaluationStartedAt).toBe(resetAt);
    expect(stats.total).toMatchObject({ attempts: 1, success: 1, unique: 1 });
    expect(stats.d30).toMatchObject({ attempts: 1, success: 1, unique: 1 });
    expect(stats.overview).toMatchObject({ totalCalls: 2, revenue: 2 });
    expect(stats.funnel).toMatchObject({ discovery_events: 1, successful_business_calls: 1 });
    expect(stats.revenue).toBe(2);
    expect(stats.trafficByClass.every((row) => row.records <= 1)).toBe(true);
    sqlite.close();
  });
});
