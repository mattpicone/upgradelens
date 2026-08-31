// UpgradeLens — entry point.
// Read-only service: it never executes caller-supplied commands, never fetches
// caller-supplied URLs, and treats all upstream content as untrusted data.

import { Hono } from "hono";
import type { Env, UpgradeCheckRequest } from "./types";
import type { AppVariables } from "./context";
import { api } from "./routes/api";
import { meta } from "./routes/meta";
import { dashboard } from "./routes/dashboard";
import { admin } from "./routes/admin";
import { applyMcpCorsHeaders, handleMcp } from "./mcp/server";
import {
  identifyCaller,
  checkRateLimit,
  recordUsage,
  recordMcpEvent,
  classifyMcpEvent,
  classifyMcpActor,
  classifyMcpSource,
  hashIdentity,
  cleanupRateCounters,
  cleanupUsageEvents,
} from "./telemetry";
import { MCP_BUSINESS_TOOL_NAMES } from "./mcp/server";
import { checkUpgrade } from "./service";
import { reconcilePendingPayments } from "./payment";
import { machineError } from "./errors";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const TRACKED_REST_PATHS = new Set([
  "/v1/upgrade/check",
  "/v1/upgrade/plan",
  "/v1/upgrade/target",
  "/v1/upgrade/batch",
]);

// ---- global middleware: identity, rate limit, telemetry --------------------
app.use("*", async (c, next) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.set("startedAt", started);
  c.header("x-request-id", requestId);

  const path = new URL(c.req.url).pathname;
  const metered = path.startsWith("/v1/") || path === "/mcp" || path === "/mcp-testnet";
  const rateLimited = !path.startsWith("/dashboard") && !path.startsWith("/admin");
  const dailyMetered = TRACKED_REST_PATHS.has(path) || path.startsWith("/v1/package/");
  // Analysis responses can contain payment challenges or caller-specific
  // billing state; never let an intermediary cache a metered REST result.
  if (TRACKED_REST_PATHS.has(path)) c.header("cache-control", "no-store");

  // Apply CORS before rate limiting so browser clients can read 4xx responses.
  // OPTIONS is observable discovery traffic but never consumes the request fuse.
  if (path === "/mcp" || path === "/mcp-testnet") applyMcpCorsHeaders(c);

  const caller = await identifyCaller(c.env, c.req.raw);
  c.set("caller", caller);
  c.set(
    "businessEligible",
    classifyMcpSource(caller.internal, caller.authState, c.req.header("user-agent")).trafficClass === "external",
  );
  const mcpSourceFor = (requestedTool?: string) => {
    const activeCaller = c.get("caller");
    return path === "/mcp-testnet"
      ? {
          trafficClass: "verification" as const,
          verificationKind: "audit" as const,
          reason: "controlled_testnet_endpoint",
        }
      : classifyMcpSource(activeCaller.internal, activeCaller.authState, c.req.header("user-agent"), requestedTool);
  };

  if (rateLimited && c.req.method !== "OPTIONS") {
    // request-size guard
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > 32 * 1024) {
      if (path === "/mcp" || path === "/mcp-testnet") {
        const source = mcpSourceFor();
        recordMcpEvent(c.env, c.executionCtx, {
          request_id: requestId,
          external: !caller.internal,
          traffic_class: source.trafficClass,
          actor_class: classifyMcpActor(source, false, false),
          verification_kind: source.verificationKind,
          classification_reason: source.reason,
          client_key: caller.clientKey,
          http_method: c.req.method,
          event_kind: "invalid",
          known_tool: false,
          tool_invoked: false,
          error_kind: "payload_too_large",
          owned_test: caller.internal,
          cache_hit: false,
          status: 413,
          latency_ms: Date.now() - started,
          unknown_result: false,
          auth_state: caller.authState,
          user_agent: c.req.header("user-agent") ?? undefined,
          referrer: c.req.header("referer") ?? undefined,
        });
      }
      return c.json(machineError("invalid_input", "Body exceeds 32KB.", false, { reason: "payload_too_large" }), 413);
    }
    // Protocol, retired-key compatibility and evidence lookup get burst protection without
    // consuming the global analysis fuse. Actual upstream work is daily-metered.
    const rate = await checkRateLimit(c.env, caller, { daily: dailyMetered });
    c.header("x-ratelimit-remaining-day", String(rate.remaining_day));
    if (!rate.allowed) {
      const res = c.json(
        machineError("rate_limited", "The request rate is temporarily limited. Retry after the indicated delay.", true, {
          retry_after_s: rate.retry_after_s,
        }),
        429,
      );
      if (TRACKED_REST_PATHS.has(path)) recordUsage(c.env, c.executionCtx, {
        request_id: requestId,
        external: !caller.internal,
        client_key: caller.clientKey,
        surface: path === "/mcp" ? "mcp" : "rest",
        tool: path,
        cache_hit: false,
        status: 429,
        latency_ms: Date.now() - started,
        unknown_result: false,
        price_usd: 0,
        cost_usd: 0,
        user_agent: c.req.header("user-agent") ?? undefined,
        referrer: c.req.header("referer") ?? undefined,
      });
      if (path === "/mcp" || path === "/mcp-testnet") {
        const source = mcpSourceFor();
        recordMcpEvent(c.env, c.executionCtx, {
          request_id: requestId,
          external: !caller.internal,
          traffic_class: source.trafficClass,
          actor_class: classifyMcpActor(source, false, false),
          verification_kind: source.verificationKind,
          classification_reason: source.reason,
          client_key: caller.clientKey,
          http_method: c.req.method,
          event_kind: "rate_limited",
          known_tool: false,
          tool_invoked: false,
          error_kind: "rate_limited",
          owned_test: caller.internal,
          cache_hit: false,
          status: 429,
          latency_ms: Date.now() - started,
          unknown_result: false,
          auth_state: caller.authState,
          user_agent: c.req.header("user-agent") ?? undefined,
          referrer: c.req.header("referer") ?? undefined,
        });
      }
      return res;
    }
  }

  await next();

  if (metered) {
    const activeCaller = c.get("caller");
    const mcpTool = c.get("mcpTool");
    // After the funnel cutover, MCP writes only to mcp_events. Dual-writing the
    // same request into legacy usage_events creates a migration race in which a
    // lossy v0 backfill can win the unique request_id before rich v1 telemetry.
    const track = TRACKED_REST_PATHS.has(path);
    if (track) recordUsage(c.env, c.executionCtx, {
      request_id: requestId,
      external: !activeCaller.internal,
      client_key: activeCaller.clientKey,
      surface: "rest",
      tool: path,
      ecosystem: c.get("meta")?.ecosystem,
      package: c.get("meta")?.package,
      cache_hit: c.get("cacheHit") === true,
      status: c.get("mcpIsError") ? 422 : c.res.status,
      latency_ms: Date.now() - started,
      unknown_result: c.get("unknownResult") === true,
      price_usd: 0,
      cost_usd: 0,
      user_agent: c.req.header("user-agent") ?? undefined,
      referrer: c.req.header("referer") ?? undefined,
    });
    if (path === "/mcp" || path === "/mcp-testnet") {
      const rpcMethod = c.get("mcpMethod");
      const knownTool = Boolean(mcpTool && MCP_BUSINESS_TOOL_NAMES.has(mcpTool));
      const toolInvoked = c.get("mcpToolInvoked") === true;
      const status = c.get("mcpIsError") ? 422 : c.res.status;
      const source = mcpSourceFor(mcpTool);
      recordMcpEvent(c.env, c.executionCtx, {
        request_id: requestId,
        external: !activeCaller.internal,
        traffic_class: source.trafficClass,
        actor_class: classifyMcpActor(source, knownTool, toolInvoked),
        verification_kind: source.verificationKind,
        classification_reason: source.reason,
        client_key: activeCaller.clientKey,
        http_method: c.req.method,
        rpc_method: rpcMethod,
        event_kind: classifyMcpEvent(rpcMethod, c.req.method),
        requested_tool: mcpTool,
        business_tool: knownTool ? mcpTool : undefined,
        known_tool: knownTool,
        tool_invoked: toolInvoked,
        tool_success: toolInvoked ? status < 400 && c.get("mcpIsError") !== true : undefined,
        rpc_error_code: c.get("mcpRpcErrorCode"),
        error_kind: c.get("mcpErrorKind") ?? (status >= 500 ? "server_error" : undefined),
        protocol_version: c.get("mcpProtocolVersion"),
        owned_test: activeCaller.internal,
        ecosystem: c.get("meta")?.ecosystem,
        package: c.get("meta")?.package,
        cache_hit: c.get("cacheHit") === true,
        status,
        latency_ms: Date.now() - started,
        unknown_result: c.get("unknownResult") === true,
        auth_state: activeCaller.authState,
        client_name: c.get("mcpClientName"),
        client_version: c.get("mcpClientVersion"),
        user_agent: c.req.header("user-agent") ?? undefined,
        referrer: c.req.header("referer") ?? undefined,
      });
    }
  }
});

// ---- routes -----------------------------------------------------------------
app.route("/v1", api);
app.route("/", meta);
app.route("/dashboard", dashboard);
app.route("/admin", admin);
app.all("/mcp-testnet", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!c.env.MCP_TESTNET_TOKEN || token !== c.env.MCP_TESTNET_TOKEN) {
    return c.json(machineError("not_found", "The controlled testnet endpoint is not enabled.", false), 404);
  }
  // Acceptance runs receive a fresh, unguessable identity so a previous
  // probe or run from the same egress address cannot consume their one free
  // evaluation. The run id is deliberately scoped to the controlled endpoint
  // and is never treated as an API key or retained in plaintext telemetry.
  const runId = c.req.header("x-upgradelens-testnet-run");
  if (runId !== undefined) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(runId)) {
      return c.json(machineError("invalid_input", "The controlled testnet run identifier is malformed.", false), 400);
    }
    const digest = await hashIdentity(`testnet-run:${token}:${runId}`);
    const current = c.get("caller");
    c.set("caller", {
      ...current,
      clientKey: `testnet:${digest}`,
      internal: false,
      keyed: false,
      plan: "testnet",
      dailyQuota: 100,
      authState: "none",
      trialSubject: digest,
    });
  }
  return handleMcp(c, { PAYMENT_MODE: "testnet" });
});
app.all("/mcp", (c) => handleMcp(c));

app.notFound((c) =>
  c.json(machineError("not_found", "Unknown endpoint. See /openapi.json and /llms.txt."), 404),
);

app.onError((err, c) => {
  console.error("unhandled_error", { message: err.message, path: c.req.path });
  return c.json(machineError("internal_error", "Internal error. No fabricated data returned.", true), 500);
});

// ---- scheduled maintenance ---------------------------------------------------
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(
    (async () => {
      try {
        await reconcilePendingPayments(env);
      } catch {
        // A facilitator outage must not stop bounded cleanup or freshness work.
      }
      try {
        await cleanupRateCounters(env);
      } catch {
        // Telemetry maintenance is independent of settlement authority.
      }
      try {
        await cleanupUsageEvents(env);
      } catch {
        // Telemetry maintenance is independent of settlement authority.
      }
      // Refresh the oldest stale pairs once per hour. Runtime context is
      // reconstructed so a runtime-specific cache entry is refreshed under
      // the same cache key; the every-minute cron is reserved for bounded
      // payment reconciliation and cleanup.
      if (new Date().getUTCMinutes() === 17) try {
        const rows = await env.DB.prepare(
          `SELECT ecosystem, package, from_version, to_version, runtime_key
           FROM upgrade_pairs
           WHERE fresh_at < ?
           ORDER BY fresh_at ASC LIMIT 4`,
        )
          .bind(new Date(Date.now() - 6 * 3600e3).toISOString())
          .all<{ ecosystem: "npm" | "pypi"; package: string; from_version: string; to_version: string; runtime_key: string }>();
        for (const r of rows.results ?? []) {
          const runtime: UpgradeCheckRequest["runtime"] = {};
          for (const part of r.runtime_key.split(",")) {
            if (part.startsWith("node:")) runtime.node = part.slice(5);
            if (part.startsWith("py:")) runtime.python = part.slice(3);
          }
          const req: UpgradeCheckRequest = {
            ecosystem: r.ecosystem,
            package: r.package,
            current_version: r.from_version,
            target_version: r.to_version,
            ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
          };
          await checkUpgrade(env, req);
        }
      } catch {
        /* best-effort refresh */
      }
    })(),
  );
}

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
