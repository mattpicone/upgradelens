import { describe, expect, it } from "vitest";
import { businessState, type Stats } from "../src/routes/dashboard";

function stats(overrides: Partial<Stats> = {}): Stats {
  const base: Stats = {
    today: {
      attempts: 0,
      unique: 0,
      repeat: 0,
      success: 0,
      failed: 0,
      service_errors: 0,
      internal_calls: 0,
    },
    total: { attempts: 0, success: 0, unique: 0, repeat: 0, firstTs: null },
    d30: {
      attempts: 0,
      success: 0,
      unique: 0,
      failed: 0,
      service_errors: 0,
      active3days: 0,
      repeat: 0,
      keyed_unique: 0,
      keyed_active3days: 0,
      keyed_repeat: 0,
    },
    daily: [],
    weeklyGrowth: [],
    fourPositiveGrowthWeeks: false,
    byTool: [],
    trafficByClass: [],
    byToolClass: [],
    byEvent: [],
    verificationAgents: [],
    topPackages: [],
    funnel: {
      discovery_events: 0,
      discovery_clients: 0,
      initialize_events: 0,
      initialize_clients: 0,
      tools_list_events: 0,
      tools_list_clients: 0,
      external_tools_call_requests: 0,
      external_tools_call_clients: 0,
      known_tool_invocations: 0,
      known_tool_invocation_clients: 0,
      successful_business_calls: 0,
      genuine_tool_clients: 0,
      repeat_genuine_tool_clients: 0,
      genuine_keyed_clients: 0,
      genuine_anonymous_identities: 0,
      repeat_keyed_clients: 0,
      repeat_anonymous_identities: 0,
      registry_verification_events: 0,
      auth_verification_events: 0,
      crawler_monitor_events: 0,
      verification_tool_calls: 0,
      invalid_auth_events: 0,
      legacy_unverifiable_events: 0,
      first_discovery_ts: null,
    },
    countsResetAt: null,
    evaluationStartedAt: new Date().toISOString(),
    unknownRate: 0,
    cacheHitRate: 0,
    latency: { p50: 0, p95: 0, p99: 0 },
    revenue: 0,
    fees: 0,
    grossProfit: 0,
    grossMargin: null,
  };
  return {
    ...base,
    ...overrides,
    today: { ...base.today, ...overrides.today },
    total: { ...base.total, ...overrides.total },
    d30: { ...base.d30, ...overrides.d30 },
    funnel: { ...base.funnel, ...overrides.funnel },
  };
}

describe("business milestone states", () => {
  it("does not promote anonymous IP-derived retention to early signal", () => {
    const state = businessState(
      stats({
        total: { attempts: 25, success: 25, unique: 3, repeat: 1, firstTs: "2026-08-28T00:00:00Z" },
        funnel: {
          genuine_tool_clients: 3,
          genuine_anonymous_identities: 3,
          repeat_genuine_tool_clients: 1,
          repeat_anonymous_identities: 1,
          successful_business_calls: 25,
        } as Partial<Stats["funnel"]> as Stats["funnel"],
      }),
    );
    expect(state.state).toBe("REPEAT ANONYMOUS TOOL IDENTITY OBSERVED");
  });

  it("requires stable keyed clients and retention for early signal", () => {
    const state = businessState(
      stats({
        total: { attempts: 25, success: 25, unique: 3, repeat: 1, firstTs: "2026-08-28T00:00:00Z" },
        funnel: {
          genuine_tool_clients: 3,
          genuine_keyed_clients: 3,
          repeat_genuine_tool_clients: 1,
          repeat_keyed_clients: 1,
          successful_business_calls: 25,
        } as Partial<Stats["funnel"]> as Stats["funnel"],
      }),
    );
    expect(state.state).toBe("EARLY SIGNAL");
  });

  it("distinguishes anonymous candidates from first stable keyed use", () => {
    const anonymous = businessState(
      stats({
        total: { attempts: 1, success: 1, unique: 1, repeat: 0, firstTs: "2026-08-29T00:00:00Z" },
        funnel: {
          successful_business_calls: 1,
          genuine_tool_clients: 1,
          genuine_anonymous_identities: 1,
        } as Partial<Stats["funnel"]> as Stats["funnel"],
      }),
    );
    const keyed = businessState(
      stats({
        total: { attempts: 1, success: 1, unique: 1, repeat: 0, firstTs: "2026-08-29T00:00:00Z" },
        funnel: {
          successful_business_calls: 1,
          genuine_tool_clients: 1,
          genuine_keyed_clients: 1,
        } as Partial<Stats["funnel"]> as Stats["funnel"],
      }),
    );
    expect(anonymous.state).toBe("CANDIDATE ORGANIC CALL OBSERVED");
    expect(keyed.state).toBe("FIRST ORGANIC CALL CONFIRMED — WAITING FOR REPEAT USER");
  });

  it("requires the full strong-signal growth and margin gates", () => {
    const strong = businessState(
      stats({
        d30: {
          attempts: 1000,
          success: 1000,
          unique: 20,
          failed: 0,
          service_errors: 0,
          active3days: 20,
          repeat: 20,
          keyed_unique: 20,
          keyed_active3days: 20,
          keyed_repeat: 20,
        },
        fourPositiveGrowthWeeks: true,
        grossMargin: 0.8,
      }),
    );
    expect(strong.state).toBe("STRONG SIGNAL");

    const missingMargin = businessState(
      stats({
        d30: { ...strongStatsD30(), success: 1000, attempts: 1000 },
        fourPositiveGrowthWeeks: true,
        grossMargin: null,
      }),
    );
    expect(missingMargin.state).toBe("MONETIZATION TEST ELIGIBLE");
  });

  it("uses the 500-call and 10-repeat monetization trigger", () => {
    const state = businessState(
      stats({
        d30: {
          attempts: 500,
          success: 500,
          unique: 10,
          failed: 0,
          service_errors: 0,
          active3days: 10,
          repeat: 10,
          keyed_unique: 10,
          keyed_active3days: 10,
          keyed_repeat: 10,
        },
      }),
    );
    expect(state.state).toBe("MONETIZATION TEST ELIGIBLE");
  });
});

function strongStatsD30(): Stats["d30"] {
  return {
    attempts: 1000,
    success: 1000,
    unique: 20,
    failed: 0,
    service_errors: 0,
    active3days: 20,
    repeat: 20,
    keyed_unique: 20,
    keyed_active3days: 20,
    keyed_repeat: 20,
  };
}
