import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { fakeEnv } from "./helpers";

type CapturedEvent = Record<string, unknown>;

function recordingD1(events: CapturedEvent[], preparedSql: string[]): D1Database {
  const prepare = (sql: string) => {
    preparedSql.push(sql);
    let args: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        args = values;
        return stmt;
      },
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO mcp_events")) {
          const columns = sql
            .match(/mcp_events\s*\(([\s\S]*?)\)\s*VALUES/i)?.[1]
            ?.split(",")
            .map((column) => column.trim());
          if (!columns) throw new Error("Could not parse MCP telemetry insert columns");
          events.push(Object.fromEntries(columns.map((column, index) => [column, args[index]])));
        }
        return { results: [{ count: 1 }], success: true, meta: {} };
      },
      raw: async () => [],
    };
    return stmt;
  };
  return {
    prepare,
    batch: async (statements: unknown[]) => statements.map(() => ({ results: [], success: true, meta: {} })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => ({}) as never,
  } as unknown as D1Database;
}

describe("MCP telemetry cutover", () => {
  const events: CapturedEvent[] = [];
  const preparedSql: string[] = [];
  const pending: Promise<unknown>[] = [];
  const env = fakeEnv({ DB: recordingD1(events, preparedSql) });
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const rpc = async (
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.20",
          "user-agent": "Claude-Code/2.4",
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response;
  };

  beforeEach(() => {
    events.length = 0;
    preparedSql.length = 0;
    pending.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.startsWith("https://api.deps.dev/v3/systems/npm/packages/left-pad")) {
          return json({
            packageKey: { name: "left-pad" },
            versions: [
              { versionKey: { version: "1.2.0" }, publishedAt: "2018-01-01T00:00:00Z" },
              { versionKey: { version: "1.3.0" }, publishedAt: "2018-04-01T00:00:00Z", isDefault: true },
            ],
          });
        }
        if (url.startsWith("https://registry.npmjs.org/left-pad/")) {
          return json({ version: url.split("/").pop(), dependencies: {}, license: "WTFPL" });
        }
        if (url.startsWith("https://api.osv.dev/v1/querybatch")) return json({ results: [{}, {}] });
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("records initialize and tools/list as discovery, not tool use", async () => {
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "claude-code", version: "2.4" },
      },
    });
    await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event_kind: "initialize",
      traffic_class: "external",
      actor_class: "unknown",
      known_tool: 0,
      tool_invoked: 0,
      tool_success: null,
      client_name: "claude-code",
      client_version: "2.4",
      protocol_version: "2025-06-18",
    });
    expect(events[1]).toMatchObject({
      event_kind: "tools_list",
      traffic_class: "external",
      actor_class: "unknown",
      known_tool: 0,
      tool_success: null,
    });
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO usage_events"))).toBe(false);
  });

  it("separates VerifyMCP auth probes and unknown tools", async () => {
    await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "__verifymcp_auth_probe_123", arguments: {} },
      },
      { authorization: "Bearer deliberately-invalid", "user-agent": "python-httpx/0.28" },
    );
    expect(events[0]).toMatchObject({
      event_kind: "tools_call",
      requested_tool: "__verifymcp_auth_probe_123",
      business_tool: null,
      known_tool: 0,
      tool_invoked: 0,
      tool_success: null,
      traffic_class: "verification",
      actor_class: "auth_verifier",
      verification_kind: "auth",
      auth_state: "invalid_key",
      error_kind: "unknown_tool",
    });
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO rate_counters"))).toBe(false);
  });

  it("keeps invalid-key calls out of the external-client class even for known tools", async () => {
    await rpc(
      {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: {
          name: "check_dependency_upgrade",
          arguments: {
            ecosystem: "npm",
            package: "left-pad",
            current_version: "1.2.0",
            target_version: "1.3.0",
          },
        },
      },
      { authorization: "Bearer deliberately-invalid" },
    );
    expect(events[0]).toMatchObject({
      known_tool: 1,
      tool_invoked: 1,
      traffic_class: "verification",
      actor_class: "auth_verifier",
      verification_kind: "auth",
      auth_state: "invalid_key",
      tool_success: 1,
    });
  });

  it("records actual semantic success and keeps owner verification internal", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "check_dependency_upgrade",
        arguments: {
          ecosystem: "npm",
          package: "left-pad",
          current_version: "1.2.0",
          target_version: "1.3.0",
        },
      },
    };
    await rpc(body);
    await rpc(body, {
      authorization: "Bearer test-owner-token",
      "user-agent": "UpgradeLens-Owner-Verification/1.0",
    });

    expect(events[0]).toMatchObject({
      event_kind: "tools_call",
      requested_tool: "check_dependency_upgrade",
      business_tool: "check_dependency_upgrade",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      traffic_class: "external",
      actor_class: "external_tool_client",
      owned_test: 0,
    });
    expect(events[1]).toMatchObject({
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 1,
      traffic_class: "internal",
      actor_class: "internal",
      owned_test: 1,
      auth_state: "owner",
    });
  });

  it("does not mark validation failures as successful business calls", async () => {
    await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "plan_dependency_upgrade",
        arguments: { ecosystem: "cargo", package: "serde" },
      },
    });
    expect(events[0]).toMatchObject({
      actor_class: "external_tool_client",
      known_tool: 1,
      tool_invoked: 1,
      tool_success: 0,
      status: 422,
      error_kind: "validation_error",
    });
  });
});
