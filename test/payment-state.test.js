import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { BASE_USDC, BASE_SEPOLIA_USDC } from "../src/contract.ts";
import { executeAnalysis, reconcilePendingPayments } from "../src/payment.ts";

const RESOURCE = "https://upgradelens.test/v1/upgrade/check";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NETWORK = "eip155:84532";
const MIGRATION = readFileSync(new URL("../migrations/0006_machine_payments.sql", import.meta.url), "utf8");

const openDatabases = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop().close();
});

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  openDatabases.push(sqlite);
  let failBatch = null;

  function prepare(sql) {
    let args = [];
    const statement = {
      sql,
      bind(...values) {
        args = values;
        return statement;
      },
      async first() {
        return sqlite.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args), success: true, meta: {} };
      },
      async run() {
        return statement.runSync();
      },
      runSync() {
        const result = sqlite.prepare(sql).run(...args);
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      },
      async raw() {
        return sqlite.prepare(sql).all(...args).map((row) => Object.values(row));
      },
    };
    return statement;
  }

  const d1 = {
    prepare,
    async batch(statements) {
      if (failBatch && statements.some((statement) => failBatch.test(statement.sql))) {
        failBatch = null;
        throw new Error("injected D1 batch failure");
      }
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    failNextBatchMatching(pattern) {
      failBatch = pattern;
    },
  };
  return { sqlite, d1 };
}

function fixture() {
  const { sqlite, d1 } = sqliteD1();
  const env = {
    DB: d1,
    ANALYSIS_VERSION: "2",
    SERVICE_VERSION: "0.3.0-test",
    PAYMENTS_ENABLED: "true",
    PAYMENT_MODE: "testnet",
    PUBLIC_BASE_URL: "https://upgradelens.test",
    X402_PAY_TO: RECIPIENT,
    TRIAL_HMAC_SECRET: "trial-secret-for-state-tests-32-bytes-minimum",
    PAYMENT_RECOVERY_SECRET: "recovery-secret-for-state-tests-32-bytes-minimum",
    CDP_API_KEY_ID: "test-key-id",
    CDP_API_KEY_SECRET: "test-key-secret",
  };
  return { sqlite, d1, env };
}

function caller(clientKey = "anon:one", trialSubject = "shared-network-subject") {
  return {
    clientKey,
    trialSubject,
    internal: false,
    keyed: clientKey.startsWith("key:"),
    plan: "anonymous",
    dailyQuota: 100,
    authState: clientKey.startsWith("key:") ? "valid_key" : "none",
  };
}

function requirements(amount = "10000") {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: BASE_SEPOLIA_USDC,
    amount,
    payTo: RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: {},
  };
}

function runtimeFixture(options = {}) {
  const mode = options.mode ?? "testnet";
  const runtimeNetwork = mode === "mainnet" ? "eip155:8453" : NETWORK;
  const runtimeAsset = mode === "mainnet" ? BASE_USDC : BASE_SEPOLIA_USDC;
  const state = { builds: 0, verifies: 0, settles: 0 };
  let verifyImpl = options.verify ?? (() => ({ isValid: true }));
  let settleImpl = options.settle ?? (() => ({ success: true, transaction: "0xtestnet-transaction", network: runtimeNetwork }));
  const server = {
    async buildPaymentRequirements({ price }) {
      state.builds += 1;
      const amount = String(Math.round(Number(String(price).replace("$", "")) * 1_000_000));
      return [{ ...requirements(amount), network: runtimeNetwork, asset: runtimeAsset }];
    },
    async createPaymentRequiredResponse(accepts, resource, error, extensions) {
      return { x402Version: 2, error, resource, accepts, extensions };
    },
    findMatchingRequirements(accepts, payload) {
      return accepts.find((candidate) =>
        candidate.scheme === payload.accepted?.scheme &&
        candidate.network === payload.accepted?.network &&
        candidate.asset.toLowerCase() === payload.accepted?.asset?.toLowerCase() &&
        candidate.amount === payload.accepted?.amount &&
        candidate.payTo.toLowerCase() === payload.accepted?.payTo?.toLowerCase()
      );
    },
    validateExtensions() {
      return options.extensionsValid ?? { valid: true };
    },
    async verifyPayment(...args) {
      state.verifies += 1;
      return verifyImpl(...args);
    },
    async settlePayment(...args) {
      state.settles += 1;
      return settleImpl(...args);
    },
  };
  return {
    runtime: { server, mode, network: runtimeNetwork },
    state,
    setVerify(fn) { verifyImpl = fn; },
    setSettle(fn) { settleImpl = fn; },
  };
}

function payload(identifier, nonce = `nonce-${identifier}`) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: requirements(),
    payload: {
      signature: "0xauthorization-signature",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        nonce,
        value: "10000",
        validAfter: "0",
        validBefore: "9999999999",
      },
    },
    extensions: {
      "payment-identifier": { info: { required: true, id: identifier } },
    },
  };
}

function paidInput(env, paymentRuntime, options = {}) {
  const args = options.args ?? {
    ecosystem: "npm",
    package: "express",
    current_version: "4.19.2",
    target_version: "5.1.0",
  };
  return {
    env,
    caller: options.caller ?? caller(),
    requestId: options.requestId ?? crypto.randomUUID(),
    operation: "check_dependency_upgrade",
    args,
    units: 1,
    resource: RESOURCE,
    skipTrial: true,
    paymentRuntime,
    paymentPayload: options.paymentPayload,
    execute: options.execute ?? (async () => ({
      decision: "proceed",
      action_allowed: true,
      target_version: args.target_version,
    })),
  };
}

function errorCode(outcome) {
  return outcome.kind === "error" ? outcome.body.error.code : null;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("rolling trial state", () => {
  it("keeps scanner-classified and invalid-auth results out of the business ledger", async () => {
    const { env, sqlite } = fixture();
    env.PAYMENT_MODE = "validation";
    const runtime = runtimeFixture();
    await executeAnalysis({
      ...paidInput(env, runtime.runtime, { requestId: "scanner-validation-call" }),
      businessEligible: false,
    });
    await executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        requestId: "invalid-auth-validation-call",
        caller: { ...caller("invalid:legacy", "other-network"), authState: "invalid_key" },
      }),
    });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM business_calls").get().count).toBe(2);
    expect(sqlite.prepare("SELECT SUM(business_eligible) AS eligible FROM business_calls").get().eligible).toBe(0);
  });

  it("shares one reservation across REST/MCP identities and legacy API keys", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture();
    let beginFirst;
    let finishFirst;
    const started = new Promise((resolve) => { beginFirst = resolve; });
    const release = new Promise((resolve) => { finishFirst = resolve; });

    const first = executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        caller: caller("anon:rest", "same-network"),
        requestId: "trial-first",
        execute: async () => {
          beginFirst();
          await release;
          return { decision: "proceed", action_allowed: true, target_version: "5.1.0" };
        },
      }),
      forcePayment: false,
      skipTrial: false,
      paymentPayload: null,
    });
    await started;
    const second = await executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        caller: caller("key:legacy-client", "same-network"),
        requestId: "trial-second",
      }),
      forcePayment: false,
      skipTrial: false,
      paymentPayload: null,
    });
    finishFirst();
    const firstOutcome = await first;

    expect(firstOutcome.kind).toBe("success");
    expect(second.kind).toBe("payment_required");
  });

  it("withholds a stale lease holder after another request reclaims and consumes the trial", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture();
    let enterFirst;
    let releaseFirst;
    const firstStarted = new Promise((resolve) => { enterFirst = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    const first = executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        requestId: "trial-stale-first",
        execute: async () => {
          enterFirst();
          await release;
          return { decision: "proceed", action_allowed: true, target_version: "5.1.0" };
        },
      }),
      skipTrial: false,
      paymentPayload: null,
    });
    await firstStarted;
    sqlite.prepare("UPDATE trial_entitlements SET reserved_at='2000-01-01T00:00:00.000Z'").run();
    const winner = await executeAnalysis({
      ...paidInput(env, runtime.runtime, { requestId: "trial-stale-winner" }),
      skipTrial: false,
      paymentPayload: null,
    });
    releaseFirst();
    const stale = await first;

    expect(winner.kind).toBe("success");
    expect(errorCode(stale)).toBe("payment_service_unavailable");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM business_calls WHERE delivery_state='delivered'").get().count).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM business_calls WHERE delivery_state='withheld'").get().count).toBe(1);
  });

  it("releases a reservation after handler failure, but consumes an unknown result", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture();
    await expect(executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        requestId: "trial-handler-failure",
        execute: async () => { throw new Error("upstream failed"); },
      }),
      forcePayment: false,
      skipTrial: false,
      paymentPayload: null,
    })).rejects.toThrow("upstream failed");

    const unknown = await executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        requestId: "trial-unknown",
        execute: async () => ({ decision: "unknown", action_allowed: false, target_version: "5.1.0" }),
      }),
      forcePayment: false,
      skipTrial: false,
      paymentPayload: null,
    });
    const afterUnknown = await executeAnalysis({
      ...paidInput(env, runtime.runtime, { requestId: "trial-after-unknown" }),
      forcePayment: false,
      skipTrial: false,
      paymentPayload: null,
    });

    expect(unknown.kind).toBe("success");
    expect(afterUnknown.kind).toBe("payment_required");
  });
});

describe("paid authorization validation", () => {
  it("requires an exact, sanitized controlled-acceptance proof before constructing mainnet terms", async () => {
    const { env, sqlite } = fixture();
    Object.assign(env, {
      PAYMENT_MODE: "mainnet",
      RELEASE_GIT_SHA: "release-sha",
      RELEASE_LOCKFILE_HASH: "lock-hash",
      RELEASE_SUITE_HASH: "suite-hash",
    });
    const recipientHash = await sha256(RECIPIENT.toLowerCase());
    sqlite.prepare(
      `INSERT INTO rollout_attestations
       (git_sha,lockfile_hash,suite_hash,testnet_transaction,service_version,price_micros,network,recipient_hash,passed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      "release-sha",
      "lock-hash",
      "suite-hash",
      `0x${"1".repeat(64)}`,
      "0.3.1",
      10000,
      NETWORK,
      recipientHash,
      new Date().toISOString(),
    );
    const evidence = {
      git_sha: "release-sha",
      lockfile_hash: "lock-hash",
      suite_hash: "suite-hash",
      recipient_hash: recipientHash,
      network: NETWORK,
      free_payment_status: "trial",
      tools: [
        { tool: "check_dependency_upgrade", transaction: `0x${"1".repeat(64)}` },
        { tool: "find_safe_upgrade_target", transaction: `0x${"2".repeat(64)}` },
        { tool: "plan_dependency_upgrade", transaction: `0x${"3".repeat(64)}` },
      ],
      idempotent_retry: true,
      unsuitable_task_rejected: true,
      bazaar_mcp_discovered: true,
      dashboard_revenue_unchanged: true,
    };
    sqlite.prepare(
      "INSERT INTO discovery_status (channel,state,evidence_json,checked_at) VALUES ('testnet_acceptance','passed',?,?)",
    ).run(JSON.stringify(evidence), new Date().toISOString());
    const runtime = runtimeFixture({ mode: "mainnet" });
    const valid = await executeAnalysis({
      ...paidInput(env, runtime.runtime, { paymentPayload: null }),
      forcePayment: true,
    });

    expect(valid.kind).toBe("payment_required");
    sqlite.prepare("UPDATE discovery_status SET evidence_json=? WHERE channel='testnet_acceptance'").run(
      JSON.stringify({ ...evidence, suite_hash: "different-suite" }),
    );
    const mismatched = await executeAnalysis({
      ...paidInput(env, runtime.runtime, { paymentPayload: null }),
      forcePayment: true,
    });
    expect(errorCode(mismatched)).toBe("payment_service_unavailable");
  });

  it("keeps the challenge probe side-effect free even when a payment payload is attached", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture();
    let executions = 0;
    const outcome = await executeAnalysis({
      ...paidInput(env, runtime.runtime, {
        paymentPayload: payload("payment-probe-must-ignore-0001"),
        execute: async () => {
          executions += 1;
          return { decision: "proceed", action_allowed: true, target_version: "5.1.0" };
        },
      }),
      forcePayment: true,
    });

    expect(outcome.kind).toBe("payment_required");
    expect(executions).toBe(0);
    expect(runtime.state).toMatchObject({ verifies: 0, settles: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM payment_attempts").get().count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM payment_events").get().count).toBe(0);
  });

  it("rejects missing identifiers and wrong versions, networks, assets, amounts, recipients, and resources", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture();

    const missingIdentifier = payload("payment-validation-0001");
    delete missingIdentifier.extensions["payment-identifier"];
    const wrongVersion = { ...payload("payment-validation-0002"), x402Version: 1 };
    const wrongResource = { ...payload("payment-validation-0003"), resource: { url: "https://attacker.test/pay" } };
    const wrongAmount = { ...payload("payment-validation-0004"), accepted: requirements("9999") };
    const wrongNetwork = { ...payload("payment-validation-0005"), accepted: { ...requirements(), network: "eip155:8453" } };
    const wrongAsset = { ...payload("payment-validation-0006"), accepted: { ...requirements(), asset: "0x3333333333333333333333333333333333333333" } };
    const wrongRecipient = { ...payload("payment-validation-0007"), accepted: { ...requirements(), payTo: "0x4444444444444444444444444444444444444444" } };
    const missingReplayMaterial = payload("payment-validation-0008");
    delete missingReplayMaterial.payload.authorization.nonce;

    const outcomes = [];
    for (const authorization of [missingIdentifier, wrongVersion, wrongResource, wrongAmount, wrongNetwork, wrongAsset, wrongRecipient, missingReplayMaterial]) {
      outcomes.push(await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization })));
    }

    expect(outcomes.map(errorCode)).toEqual(Array(8).fill("payment_invalid"));
    expect(outcomes.map((outcome) => outcome.kind === "error" ? outcome.status : 0)).toEqual([400, 402, 402, 402, 402, 402, 402, 400]);
    expect(runtime.state.verifies).toBe(0);
  });

  it("rejects expired and tampered authorizations when facilitator verification fails", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture({
      verify: (authorization) => authorization.payload.authorization.validBefore === "1"
        ? { isValid: false, invalidReason: "authorization_expired" }
        : { isValid: false, invalidReason: "invalid_signature" },
    });
    const expired = payload("payment-expired-0001");
    expired.payload.authorization.validBefore = "1";
    const tampered = payload("payment-tampered-0001");
    tampered.payload.authorization.value = "20000";

    const expiredOutcome = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: expired }));
    const tamperedOutcome = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: tampered }));

    expect(errorCode(expiredOutcome)).toBe("payment_invalid");
    expect(expiredOutcome.kind === "error" && expiredOutcome.body.error.message).toContain("authorization_expired");
    expect(errorCode(tamperedOutcome)).toBe("payment_invalid");
    expect(runtime.state).toMatchObject({ verifies: 2, settles: 0 });
  });
});

describe("paid execution and settlement state machine", () => {
  it("returns a durable cached result for an idempotent retry and never stores the raw identifier", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture();
    const authorization = payload("payment-idempotent-0001");
    let executions = 0;
    const makeInput = () => paidInput(env, runtime.runtime, {
      paymentPayload: authorization,
      execute: async () => {
        executions += 1;
        return { decision: "proceed", action_allowed: true, target_version: "5.1.0" };
      },
    });

    const first = await executeAnalysis(makeInput());
    const second = await executeAnalysis(makeInput());
    const stored = sqlite.prepare("SELECT payment_identifier, recovery_payload FROM payment_attempts").get();

    expect(first.kind).toBe("success");
    expect(second.kind).toBe("success");
    expect(second.kind === "success" && second.result.billing.payment_status).toBe("cached_settlement");
    expect(executions).toBe(1);
    expect(runtime.state).toMatchObject({ verifies: 1, settles: 1 });
    expect(stored.payment_identifier).not.toContain("payment-idempotent-0001");
    expect(stored.recovery_payload).toBeNull();
  });

  it("binds identifiers to one request and rejects nonce replay across identifiers", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture();
    const sharedNonce = "shared-eip3009-nonce";
    const firstAuthorization = payload("payment-binding-0001", sharedNonce);
    const first = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: firstAuthorization }));
    const conflict = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: firstAuthorization,
      args: { ecosystem: "npm", package: "react", current_version: "18.0.0", target_version: "19.0.0" },
    }));
    const replay = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: payload("payment-binding-0002", sharedNonce),
    }));

    expect(first.kind).toBe("success");
    expect(errorCode(conflict)).toBe("identifier_conflict");
    expect(errorCode(replay)).toBe("payment_replay");
    expect(runtime.state.settles).toBe(1);
  });

  it("rejects a settlement transaction already bound to another identifier", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture();
    const first = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: payload("payment-transaction-0001", "unique-nonce-one"),
    }));
    const duplicate = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: payload("payment-transaction-0002", "unique-nonce-two"),
    }));

    expect(first.kind).toBe("success");
    expect(errorCode(duplicate)).toBe("payment_replay");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM billing_ledger_v3").get().count).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM payment_attempts WHERE settlement_state='failed'").get().count).toBe(1);
  });

  it("withholds a success receipt that is missing a transaction or names the wrong network", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture({
      settle: () => ({ success: true, transaction: "0xwrong-network", network: "eip155:8453" }),
    });
    const outcome = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: payload("payment-receipt-network-0001"),
    }));

    expect(errorCode(outcome)).toBe("payment_pending");
    expect(sqlite.prepare("SELECT settlement_state, failure_code FROM payment_attempts").get()).toMatchObject({
      settlement_state: "pending",
      failure_code: "invalid_settlement_receipt",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM billing_ledger_v3").get().count).toBe(0);
    expect(sqlite.prepare("SELECT delivery_state FROM business_calls").get().delivery_state).toBe("withheld");
  });

  it("allows only one executor through a concurrent retry race", async () => {
    const { env } = fixture();
    let enterVerify;
    let releaseVerify;
    const verifying = new Promise((resolve) => { enterVerify = resolve; });
    const release = new Promise((resolve) => { releaseVerify = resolve; });
    const runtime = runtimeFixture({
      verify: async () => {
        enterVerify();
        await release;
        return { isValid: true };
      },
    });
    const authorization = payload("payment-concurrent-0001");
    let executions = 0;
    const makeInput = () => paidInput(env, runtime.runtime, {
      paymentPayload: authorization,
      execute: async () => {
        executions += 1;
        return { decision: "proceed", action_allowed: true, target_version: "5.1.0" };
      },
    });

    const first = executeAnalysis(makeInput());
    await verifying;
    const racingRetry = await executeAnalysis(makeInput());
    releaseVerify();
    const firstOutcome = await first;

    expect(errorCode(racingRetry)).toBe("payment_pending");
    expect(firstOutcome.kind).toBe("success");
    expect(executions).toBe(1);
    expect(runtime.state).toMatchObject({ verifies: 1, settles: 1 });
  });

  it("never settles when the analysis handler fails", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture();
    const outcome = await executeAnalysis(paidInput(env, runtime.runtime, {
      paymentPayload: payload("payment-handler-failure-0001"),
      execute: async () => { throw new Error("analysis failed"); },
    }));
    const attempt = sqlite.prepare("SELECT settlement_state, failure_code, recovery_payload FROM payment_attempts").get();

    expect(errorCode(outcome)).toBe("payment_service_unavailable");
    expect(runtime.state.settles).toBe(0);
    expect(attempt).toMatchObject({ settlement_state: "handler_failed", failure_code: "handler_failed", recovery_payload: null });
  });

  it("withholds an ambiguous settlement, then reconciles and delivers the saved result", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture({ settle: () => { throw new Error("facilitator timeout"); } });
    const authorization = payload("payment-reconcile-0001");
    const initial = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization }));
    let attempt = sqlite.prepare("SELECT settlement_state, recovery_payload FROM payment_attempts").get();
    let call = sqlite.prepare("SELECT execution_state, delivery_state, result_json FROM business_calls").get();

    expect(errorCode(initial)).toBe("payment_pending");
    expect(attempt.settlement_state).toBe("pending");
    expect(attempt.recovery_payload).toMatch(/^v1\./);
    expect(attempt.recovery_payload).not.toContain("payment-reconcile-0001");
    expect(call).toMatchObject({ execution_state: "result_saved", delivery_state: "withheld" });

    runtime.setSettle(() => ({ success: true, transaction: "0xreconciled", network: NETWORK }));
    expect(await reconcilePendingPayments(env, 8, runtime.runtime)).toBe(1);
    attempt = sqlite.prepare("SELECT settlement_state, recovery_payload FROM payment_attempts").get();
    call = sqlite.prepare("SELECT execution_state, delivery_state FROM business_calls").get();
    const retry = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization }));

    expect(attempt).toMatchObject({ settlement_state: "settled", recovery_payload: null });
    expect(call).toMatchObject({ execution_state: "complete", delivery_state: "delivered" });
    expect(retry.kind).toBe("success");
    expect(retry.kind === "success" && retry.result.billing.payment_status).toBe("cached_settlement");
  });

  it("recovers a stale executing attempt after a crash that followed durable result storage", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture({ settle: () => { throw new Error("worker interrupted"); } });
    const authorization = payload("payment-crash-recovery-0001");
    expect(errorCode(await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization })))).toBe("payment_pending");
    sqlite.prepare(
      "UPDATE payment_attempts SET settlement_state='executing', updated_at='2000-01-01T00:00:00.000Z'",
    ).run();

    runtime.setSettle(() => ({ success: true, transaction: "0xafter-crash", network: NETWORK }));
    expect(await reconcilePendingPayments(env, 8, runtime.runtime)).toBe(1);
    expect(sqlite.prepare("SELECT settlement_state FROM payment_attempts").get().settlement_state).toBe("settled");
    expect(sqlite.prepare("SELECT delivery_state FROM business_calls").get().delivery_state).toBe("delivered");
  });

  it("closes a pending authorization after a terminal reconciliation response", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture({ settle: () => ({ success: false, errorReason: "settlement_pending" }) });
    const authorization = payload("payment-terminal-0001");
    expect(errorCode(await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization })))).toBe("payment_pending");

    runtime.setSettle(() => ({ success: false, errorReason: "insufficient_funds", errorMessage: "not enough USDC" }));
    expect(await reconcilePendingPayments(env, 8, runtime.runtime)).toBe(0);
    const attempt = sqlite.prepare("SELECT settlement_state, failure_code, recovery_payload FROM payment_attempts").get();
    const retry = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization }));

    expect(attempt).toMatchObject({ settlement_state: "failed", failure_code: "insufficient_funds", recovery_payload: null });
    expect(errorCode(retry)).toBe("payment_service_unavailable");
  });

  it("leases a pending settlement so overlapping cron invocations cannot submit it twice", async () => {
    const { env } = fixture();
    const runtime = runtimeFixture({ settle: () => { throw new Error("initial timeout"); } });
    const authorization = payload("payment-reconcile-lease-0001");
    expect(errorCode(await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization })))).toBe("payment_pending");

    let enterSettlement;
    let releaseSettlement;
    const settling = new Promise((resolve) => { enterSettlement = resolve; });
    const release = new Promise((resolve) => { releaseSettlement = resolve; });
    runtime.setSettle(async () => {
      enterSettlement();
      await release;
      return { success: true, transaction: "0xleased", network: NETWORK };
    });

    const firstCron = reconcilePendingPayments(env, 8, runtime.runtime);
    await settling;
    const overlappingCron = await reconcilePendingPayments(env, 8, runtime.runtime);
    releaseSettlement();

    expect(overlappingCron).toBe(0);
    expect(await firstCron).toBe(1);
    expect(runtime.state.settles).toBe(2); // one initial attempt + one claimed reconciliation
  });

  it("finishes an existing authorization even after the margin gate blocks new charges", async () => {
    const { env, sqlite } = fixture();
    const runtime = runtimeFixture({ settle: () => { throw new Error("initial timeout"); } });
    const authorization = payload("payment-margin-pause-0001");
    expect(errorCode(await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization })))).toBe("payment_pending");

    Object.assign(env, {
      PAYMENT_MODE: "mainnet",
      KNOWN_UNIT_COST_MICROS: "9000",
    });
    runtime.setSettle(() => ({ success: true, transaction: "0xmargin-reconciled", network: NETWORK }));
    expect(await reconcilePendingPayments(env, 8, runtime.runtime)).toBe(1);
    expect(sqlite.prepare("SELECT settlement_state FROM payment_attempts").get().settlement_state).toBe("settled");
    expect(sqlite.prepare("SELECT eligible_mainnet FROM billing_ledger_v3").get().eligible_mainnet).toBe(0);
  });

  it("reconciles a successful receipt after an atomic ledger-write failure without settling twice", async () => {
    const { env, d1, sqlite } = fixture();
    const runtime = runtimeFixture();
    d1.failNextBatchMatching(/billing_ledger_v3/);
    const authorization = payload("payment-ledger-recovery-0001");
    const initial = await executeAnalysis(paidInput(env, runtime.runtime, { paymentPayload: authorization }));

    expect(errorCode(initial)).toBe("payment_pending");
    expect(runtime.state.settles).toBe(1);
    env.KNOWN_UNIT_COST_MICROS = "2000";
    expect(await reconcilePendingPayments(env, 8, runtime.runtime)).toBe(1);
    expect(runtime.state.settles).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM billing_ledger_v3").get().count).toBe(1);
    expect(sqlite.prepare("SELECT fee_micros FROM billing_ledger_v3").get().fee_micros).toBe(1000);
    expect(sqlite.prepare("SELECT settlement_state FROM payment_attempts").get().settlement_state).toBe("settled");
  });
});
