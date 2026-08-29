import { describe, expect, it } from "vitest";
import {
  checkKeyIssuance,
  checkRateLimit,
  classifyMcpActor,
  classifyMcpEvent,
  classifyMcpSource,
  identifyCaller,
  reserveCacheMiss,
} from "../src/telemetry";
import type { CallerIdentity } from "../src/telemetry";
import { fakeEnv } from "./helpers";

function counterDb(seed: Record<string, number> = {}): { db: D1Database; counters: Map<string, number> } {
  const counters = new Map(Object.entries(seed));
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        args = values;
        return stmt;
      },
      first: async () => {
        if (!sql.includes("SELECT count FROM rate_counters")) return null;
        const count = counters.get(String(args[0]));
        return count === undefined ? null : { count };
      },
      run: async () => {
        const bucket = String(args[0]);
        const current = counters.get(bucket) ?? 0;
        let increment = 1;
        let cap = Infinity;
        if (sql.includes("count + excluded.count <= ?")) {
          increment = Number(args[1]);
          cap = Number(args[3]);
        } else if (sql.includes("WHERE count < 2")) {
          cap = 2;
        } else if (sql.includes("WHERE count < ?")) {
          cap = Number(args[2]);
        }
        if (current + increment > cap) return { results: [], success: true, meta: {} };
        const count = current + increment;
        counters.set(bucket, count);
        return { results: [{ count }], success: true, meta: {} };
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    };
    return stmt;
  };
  return {
    counters,
    db: { prepare } as unknown as D1Database,
  };
}

describe("quota hardening", () => {
  it("stops writing a caller counter after the daily limit", async () => {
    const { db, counters } = counterDb();
    const env = fakeEnv({ DB: db });
    const caller: CallerIdentity = {
      clientKey: "anon:test",
      internal: false,
      keyed: false,
      plan: "anon",
      dailyQuota: 2,
      authState: "none",
    };
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(true);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(true);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(false);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(false);
    const bucket = [...counters.keys()].find((key) => key.startsWith("d:"));
    expect(counters.get(bucket!)).toBe(2);
  });

  it("does not increment exhausted key-issuance counters", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const bucket = `k:${day}:anon:test`;
    const { db, counters } = counterDb({ [bucket]: 2 });
    const env = fakeEnv({ DB: db });
    const result = await checkKeyIssuance(env, {
      clientKey: "anon:test",
      internal: false,
      keyed: false,
      plan: "anon",
      dailyQuota: 100,
      authState: "none",
    });
    expect(result.allowed).toBe(false);
    expect(counters.get(bucket)).toBe(2);
  });

  it("does not increment the exhausted cache-miss fuse", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const bucket = `g:${day}:miss`;
    const { db, counters } = counterDb({ [bucket]: 1000 });
    expect(await reserveCacheMiss(fakeEnv({ DB: db }))).toBe(false);
    expect(counters.get(bucket)).toBe(1000);
  });
});

describe("MCP traffic classification", () => {
  it("recognizes owner bearer authentication case-insensitively", async () => {
    const caller = await identifyCaller(
      fakeEnv(),
      new Request("https://upgradelens.test/mcp", {
        headers: { authorization: "bearer test-owner-token" },
      }),
    );
    expect(caller).toMatchObject({ internal: true, clientKey: "owner", authState: "owner" });
  });

  it("separates owner, registry/auth, audit/monitor, and ordinary external traffic", () => {
    const owner = classifyMcpSource(true, "owner", "UpgradeLens-Owner-Verification/1.0");
    expect(owner).toMatchObject({ trafficClass: "internal", verificationKind: "none" });
    expect(classifyMcpActor(owner, true, true)).toBe("internal");

    const registry = classifyMcpSource(false, "none", "ProofBench-Registry/1.0");
    expect(registry).toMatchObject({ trafficClass: "verification", verificationKind: "registry" });
    expect(classifyMcpActor(registry, false, false)).toBe("registry_verifier");

    const auth = classifyMcpSource(false, "invalid_key", "python-httpx", "__verifymcp_auth_probe_7");
    expect(auth).toMatchObject({ trafficClass: "verification", verificationKind: "auth" });
    expect(classifyMcpActor(auth, false, false)).toBe("auth_verifier");

    const audit = classifyMcpSource(false, "none", "SaSame-MCP-Audit/0.1");
    expect(audit).toMatchObject({ trafficClass: "verification", verificationKind: "audit" });
    expect(classifyMcpActor(audit, true, true)).toBe("crawler_monitor");

    const real = classifyMcpSource(false, "none", "Claude-Code/2.4");
    expect(real).toMatchObject({ trafficClass: "external", verificationKind: "none" });
    expect(classifyMcpActor(real, true, true)).toBe("external_tool_client");
    expect(classifyMcpActor(real, false, false)).toBe("unknown");
  });

  it("does not classify ordinary names containing bot as crawler traffic", () => {
    expect(classifyMcpSource(false, "none", "Dependabot/1.0").trafficClass).toBe("external");
    expect(classifyMcpSource(false, "none", "RoboticsAgent/1.0").trafficClass).toBe("external");
  });

  it("recognizes the known production discovery agents without broad intent keywords", () => {
    const knownAgents = [
      "SentinelOracle/0.1",
      "mcpbeat/0.1",
      "agent-tools.cloud-crawler/0.1",
      "ProofBench/0.1",
      "mcpscan/1.0",
      "MCPWatch/0.1.0",
      "mcp2-research/1.0",
      "mcpgrade-probe/0.1",
      "GolemreachTrustBot/0.1",
      "AgentIndexBot/0.1",
      "x402-observatory/0.2",
      "rootz-mcp-registry-prober/0.1",
      "measure-mcp-schema/0.1.0",
    ];
    for (const userAgent of knownAgents) {
      expect(classifyMcpSource(false, "none", userAgent).trafficClass).toBe("verification");
    }
    expect(classifyMcpSource(false, "none", "Dependency Research Assistant/1.0").trafficClass).toBe(
      "external",
    );
    expect(classifyMcpSource(false, "none", "Security Upgrade Agent/1.0").trafficClass).toBe(
      "external",
    );
  });

  it("separates transport, tools/list, tools/call, and invalid protocol traffic", () => {
    expect(classifyMcpEvent("initialize", "POST")).toBe("initialize");
    expect(classifyMcpEvent("tools/list", "POST")).toBe("tools_list");
    expect(classifyMcpEvent("tools/call", "POST")).toBe("tools_call");
    expect(classifyMcpEvent("http:post", "POST")).toBe("invalid");
    expect(classifyMcpEvent("http:get", "GET")).toBe("transport");
  });
});
