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
import { handleMcp } from "./mcp/server";
import {
  identifyCaller,
  checkRateLimit,
  recordUsage,
  cleanupRateCounters,
} from "./telemetry";
import { checkUpgrade } from "./service";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---- global middleware: identity, rate limit, telemetry --------------------
app.use("*", async (c, next) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.set("startedAt", started);
  c.header("x-request-id", requestId);

  const path = new URL(c.req.url).pathname;
  const metered = path.startsWith("/v1/") || path === "/mcp";

  const caller = await identifyCaller(c.env, c.req.raw);
  c.set("caller", caller);

  if (metered) {
    // request-size guard
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > 32 * 1024) {
      return c.json({ error: { code: "payload_too_large", message: "Body exceeds 32KB." } }, 413);
    }
    const rate = await checkRateLimit(c.env, caller);
    c.header("x-ratelimit-remaining-day", String(rate.remaining_day));
    if (!rate.allowed) {
      const res = c.json(
        {
          error: {
            code: "rate_limited",
            message:
              "Free quota exceeded. Create a free API key via POST /v1/keys for higher limits, or retry later.",
            retry_after_s: rate.retry_after_s,
          },
        },
        429,
      );
      recordUsage(c.env, c.executionCtx, {
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
      return res;
    }
  }

  await next();

  if (metered) {
    const mcpTool = c.get("mcpTool");
    recordUsage(c.env, c.executionCtx, {
      request_id: requestId,
      external: !caller.internal,
      client_key: caller.clientKey,
      surface: path === "/mcp" ? "mcp" : "rest",
      tool: path === "/mcp" ? (mcpTool ? `mcp:${mcpTool}` : "mcp:protocol") : path,
      ecosystem: c.get("meta")?.ecosystem,
      package: c.get("meta")?.package,
      cache_hit: c.get("cacheHit") === true,
      status: c.res.status,
      latency_ms: Date.now() - started,
      unknown_result: c.get("unknownResult") === true,
      price_usd: 0,
      cost_usd: 0,
      user_agent: c.req.header("user-agent") ?? undefined,
      referrer: c.req.header("referer") ?? undefined,
    });
  }
});

// ---- routes -----------------------------------------------------------------
app.route("/v1", api);
app.route("/", meta);
app.route("/dashboard", dashboard);
app.route("/admin", admin);
app.all("/mcp", (c) => handleMcp(c));

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "Unknown endpoint. See /openapi.json and /llms.txt.",
      },
    },
    404,
  ),
);

app.onError((err, c) => {
  console.error("unhandled_error", { message: err.message, path: c.req.path });
  return c.json(
    { error: { code: "internal_error", message: "Internal error. No fabricated data returned." } },
    500,
  );
});

// ---- scheduled maintenance ---------------------------------------------------
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(
    (async () => {
      await cleanupRateCounters(env);
      // Refresh the most-demanded stale pairs (demand-weighted freshness).
      try {
        const rows = await env.DB.prepare(
          `SELECT ecosystem, package, from_version, to_version
           FROM upgrade_pairs
           WHERE fresh_at < ?
           ORDER BY rowid DESC LIMIT 4`,
        )
          .bind(new Date(Date.now() - 6 * 3600e3).toISOString())
          .all<{ ecosystem: "npm" | "pypi"; package: string; from_version: string; to_version: string }>();
        for (const r of rows.results ?? []) {
          const req: UpgradeCheckRequest = {
            ecosystem: r.ecosystem,
            package: r.package,
            current_version: r.from_version,
            target_version: r.to_version,
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
