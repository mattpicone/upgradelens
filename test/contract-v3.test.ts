import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, MCP_TOOLS, openApiDocument, paymentMode, pricingDocument, registryMetadata } from "../src/contract";
import { fakeEnv } from "./helpers";
import { deriveTrialSubject } from "../src/telemetry";
import { paymentActivation } from "../src/payment";
import { executeAnalysis } from "../src/payment";

describe("v0.3 machine contract", () => {
  it("keeps one canonical capability catalog for MCP and OpenAPI", () => {
    expect(CONTRACT_VERSION).toBe("0.3.1");
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "check_dependency_upgrade",
      "find_safe_upgrade_target",
      "plan_dependency_upgrade",
    ]);
    const openapi = openApiDocument(fakeEnv());
    expect(openapi.info.version).toBe(CONTRACT_VERSION);
    expect(Object.keys(openapi.paths)).toEqual(expect.arrayContaining([
      "/v1/upgrade/check",
      "/v1/upgrade/target",
      "/v1/upgrade/plan",
    ]));
  });

  it("publishes exact unit pricing and capability-first registry metadata", () => {
    const env = fakeEnv({ PAYMENT_MODE: "testnet" });
    const pricing = pricingDocument(env);
    expect(pricing.unit).toEqual({ name: "analysis", price_usd: 0.01, atomic_usdc: "10000" });
    expect(pricing.free_entitlement).toMatchObject({ units: 1, rolling_days: 30, shared_across: ["mcp", "rest"] });
    expect(pricing.economics).toEqual({
      known_unit_cost_micros: 1000,
      minimum_gross_margin: 0.75,
      maximum_safe_unit_cost_micros: 2500,
      margin_gate_ready: true,
    });
    expect(registryMetadata(env).version).toBe(CONTRACT_VERSION);
    expect(registryMetadata(env)._meta.operations).toHaveLength(3);
    expect(registryMetadata(env).description.length).toBeLessThanOrEqual(100);
    for (const term of ["dependency", "upgrade", "package", "security", "compatibility", "migration"]) {
      expect(registryMetadata(env).description.toLowerCase()).toContain(term);
    }
  });

  it("derives a stable HMAC trial subject without storing a raw network address", async () => {
    const env = fakeEnv({ TRIAL_HMAC_SECRET: "test-secret" });
    const first = await deriveTrialSubject(env, new Request("https://example.test", { headers: { "cf-connecting-ip": "198.051.100.020" } }));
    const second = await deriveTrialSubject(env, new Request("https://example.test", { headers: { "cf-connecting-ip": "198.51.100.20" } }));
    const other = await deriveTrialSubject(env, new Request("https://example.test", { headers: { "cf-connecting-ip": "198.51.100.21" } }));
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(first).not.toContain("198.51.100.20");
  });

  it("fails closed for paid modes until every merchant prerequisite exists", () => {
    const activation = paymentActivation(fakeEnv({ PAYMENT_MODE: "mainnet", TRIAL_HMAC_SECRET: "trial" }));
    expect(activation.mode).toBe("mainnet");
    expect(activation.ready).toBe(false);
    expect(activation.blockers).toEqual(expect.arrayContaining([
      "X402_PAY_TO is not a valid configured EVM recipient",
      "PAYMENT_RECOVERY_SECRET must contain at least 32 bytes",
      "CDP_API_KEY_ID is not configured",
      "CDP_API_KEY_SECRET is not configured",
    ]));
  });

  it("automatically blocks mainnet when known unit costs break the margin floor", () => {
    const activation = paymentActivation(fakeEnv({
      PAYMENT_MODE: "mainnet",
      TRIAL_HMAC_SECRET: "trial-secret-at-least-32-bytes-long",
      PAYMENT_RECOVERY_SECRET: "recovery-secret-at-least-32-bytes-long",
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
      RELEASE_GIT_SHA: "sha",
      RELEASE_LOCKFILE_HASH: "lock",
      RELEASE_SUITE_HASH: "suite",
      KNOWN_UNIT_COST_MICROS: "2501",
    }));
    expect(activation.ready).toBe(false);
    expect(activation.blockers).toContain("Known unit costs would reduce gross margin below 75%");
  });

  it("does not turn an invalid payment-mode value into free validation", () => {
    expect(paymentMode(fakeEnv({ PAYMENT_MODE: "misconfigured" as never }))).toBe("paused");
  });

  it("adds the billing and next-action envelope on the shared free path", async () => {
    const outcome = await executeAnalysis({
      env: fakeEnv({ PAYMENT_MODE: "validation" }),
      caller: { clientKey: "anon:test", internal: false, keyed: false, plan: "anon", dailyQuota: 1, authState: "none" },
      requestId: "contract-test",
      operation: "check_dependency_upgrade",
      args: { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0" },
      units: 1,
      resource: "https://example.test/v1/upgrade/check",
      execute: async () => ({ decision: "proceed", action_allowed: true, target_version: "5.1.0" }),
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.result.next_action).toBe("apply_upgrade");
      expect(outcome.result.billing).toMatchObject({ mode: "validation", units: 1, payment_status: "validation_free" });
    }
  });
});
