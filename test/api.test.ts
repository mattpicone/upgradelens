// REST API integration tests (fake D1, mocked upstreams where needed).

import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { fakeEnv, fakeCtx } from "./helpers";

const env = fakeEnv();

const post = (path: string, body: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
    fakeCtx,
  );

describe("REST validation and errors", () => {
  it("rejects a malformed PAYMENT-SIGNATURE instead of treating it as absent", async () => {
    const res = await app.request(
      "/v1/upgrade/check",
      {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": "not-valid-base64-or-json" },
        body: JSON.stringify({
          ecosystem: "npm",
          package: "express",
          current_version: "4.19.2",
          target_version: "5.1.0",
        }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("payment_invalid");
  });

  it("rejects a base64-encoded non-object PAYMENT-SIGNATURE", async () => {
    const res = await app.request(
      "/v1/upgrade/check",
      {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": btoa("null") },
        body: JSON.stringify({
          ecosystem: "npm",
          package: "express",
          current_version: "4.19.2",
          target_version: "5.1.0",
        }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("payment_invalid");
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await app.request(
      "/v1/upgrade/check",
      { method: "POST", body: "{broken", headers: { "content-type": "application/json" } },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("invalid_json");
  });

  it("rejects unsupported ecosystems with a helpful message", async () => {
    const res = await post("/v1/upgrade/check", {
      ecosystem: "cargo",
      package: "serde",
      current_version: "1.0.0",
      target_version: "1.0.1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/npm.*pypi|pypi.*npm/);
    expect(body.error.field).toBe("ecosystem");
  });

  it("rejects oversized batches", async () => {
    const pair = {
      ecosystem: "npm",
      package: "x",
      current_version: "1.0.0",
      target_version: "1.0.1",
    };
    const res = await post("/v1/upgrade/batch", { pairs: Array(6).fill(pair) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("batch_too_large");
  });

  it("rejects payloads over the size cap", async () => {
    const res = await app.request(
      "/v1/upgrade/check",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
        body: JSON.stringify({}),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(413);
  });

  it("counts the actual body when Content-Length is absent", async () => {
    const res = await app.request(
      "/v1/upgrade/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("payload_too_large");
  });

  it("404s unknown endpoints with pointer to docs", async () => {
    const res = await app.request("/v1/nonsense", {}, env, fakeCtx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/openapi/);
  });

  it("rejects invalid evidence ids without touching the DB", async () => {
    const res = await app.request("/v1/evidence/../../etc", {}, env, fakeCtx);
    expect(res.status).toBe(404);
  });
});

describe("meta surfaces", () => {
  it("serves openapi.json with all endpoints", async () => {
    const res = await app.request("/openapi.json", {}, env, fakeCtx);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/upgrade/check",
        "/v1/upgrade/plan",
        "/v1/upgrade/target",
        "/v1/upgrade/batch",
        "/v1/package/{ecosystem}/{name}",
        "/healthz",
      ]),
    );
  });

  it("serves llms.txt as a selection document with when/do-not-use and examples", async () => {
    const res = await app.request("/llms.txt", {}, env, fakeCtx);
    const text = await res.text();
    expect(text).toMatch(/\/mcp/);
    expect(text).toMatch(/check_dependency_upgrade/);
    expect(text).toMatch(/find_safe_upgrade_target/);
    expect(text).toMatch(/plan_dependency_upgrade/);
    expect(text).toMatch(/Use when/);
    expect(text).toMatch(/Do not use when/);
    expect(text).toMatch(/"ecosystem":"npm"/);
    expect(text).toMatch(/"ecosystem":"pypi"/);
    expect(text).toMatch(/max_major_jump/);
    expect(text).toMatch(/read the project manifest first/);
  });

  it("serves pricing.json with the v0.3 machine payment contract", async () => {
    const res = await app.request("/pricing.json", {}, env, fakeCtx);
    const body = (await res.json()) as any;
    expect(body.mode).toBe("validation");
    expect(body.unit).toEqual({ name: "analysis", price_usd: 0.01, atomic_usdc: "10000" });
    expect(body.free_entitlement).toMatchObject({ units: 1, rolling_days: 30 });
    expect(body.payment_activation.ready).toBe(true);
  });

  it("healthz responds", async () => {
    const res = await app.request("/healthz", {}, env, fakeCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.service).toBe("upgradelens");
    expect(["ok", "missing_or_outdated"]).toContain(body.telemetry_schema);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("landing page leads with install snippets and the official Cursor link", async () => {
    const res = await app.request("/", {}, env, fakeCtx);
    const html = await res.text();
    expect(html).toMatch(/mcpServers/);
    expect(html).toMatch(/claude mcp add --transport http upgradelens/);
    expect(html).toMatch(/\[mcp_servers\.upgradelens\]/);
    expect(html).toMatch(/cursor\.com\/install-mcp\?name=upgradelens/);
    expect(html).toMatch(/Anonymous free evaluation quota/);
    expect(html).toMatch(/no API key required/);
    expect(html).toMatch(/Read-only/);
    expect(html).toMatch(/npm and PyPI only/);
    const installAt = html.indexOf("<h2>Install</h2>");
    const restAt = html.indexOf("REST API");
    expect(installAt).toBeGreaterThan(0);
    expect(installAt).toBeLessThan(restAt);
  });
});

describe("dashboard auth", () => {
  it("requires the owner token", async () => {
    const res = await app.request("/dashboard", {}, env, fakeCtx);
    expect(res.status).toBe(401);
  });
  it("accepts the owner token", async () => {
    const res = await app.request(
      "/dashboard",
      { headers: { authorization: "Bearer test-owner-token" } },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Waiting for real users|Owner dashboard/);
    expect(html).toMatch(/All calls/);
    expect(html).toMatch(/Good calls/);
    expect(html).toMatch(/Money made/);
    expect(html).toMatch(/<details>/);
    expect(html).not.toMatch(/<details\s+open/);
    expect(html).toMatch(/View details/);
    expect(html).toMatch(/\$0\.00/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("defines the business population explicitly in JSON", async () => {
    const res = await app.request(
      "/dashboard?format=json",
      { headers: { authorization: "bearer test-owner-token" } },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.business_state.state).toBe("WAITING FOR FIRST ORGANIC TOOL CALL");
    expect(body.definition.genuine_business_tool_call).toMatch(/post-cutover.*handler invoked.*semantic success/);
    expect(body).toHaveProperty("counts_reset_at");
    expect(body).toHaveProperty("counts_reset_scope");
    expect(body.stats.countsResetAt).toBeNull();
    expect(body.stats.overview).toEqual({ totalCalls: 0, revenue: 0 });
    expect(body.stats.total.success).toBe(0);
    expect(body.stats.funnel.repeat_genuine_tool_clients).toBe(0);
  });
  it("503s when no owner token is configured", async () => {
    const res = await app.request(
      "/dashboard",
      { headers: { authorization: "Bearer x" } },
      fakeEnv({ OWNER_TOKEN: undefined }),
      fakeCtx,
    );
    expect(res.status).toBe(503);
  });
  it("does not accept owner secrets in the query string", async () => {
    const res = await app.request("/dashboard?token=test-owner-token", {}, env, fakeCtx);
    expect(res.status).toBe(401);
  });
  it("serves a browser sign-in form when logged out", async () => {
    const res = await app.request("/dashboard", {}, env, fakeCtx);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toMatch(/action="\/dashboard\/login"/);
    expect(html).toMatch(/type="password"/);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });
  it("signs in with a one-time token paste and a scoped HttpOnly cookie", async () => {
    const login = await app.request(
      "/dashboard/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=test-owner-token",
      },
      env,
      fakeCtx,
    );
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/ul_owner=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\/dashboard/i);

    const res = await app.request(
      "/dashboard",
      { headers: { cookie: "ul_owner=test-owner-token" } },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/owner dashboard/i);
  });
  it("rejects a wrong token at sign-in and clears the session on logout", async () => {
    const bad = await app.request(
      "/dashboard/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=wrong",
      },
      env,
      fakeCtx,
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const logout = await app.request(
      "/dashboard/logout",
      { method: "POST", headers: { cookie: "ul_owner=test-owner-token" } },
      env,
      fakeCtx,
    );
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toMatch(/ul_owner=;|Max-Age=0/i);

    const wrongCookie = await app.request(
      "/dashboard",
      { headers: { cookie: "ul_owner=wrong" } },
      env,
      fakeCtx,
    );
    expect(wrongCookie.status).toBe(401);
  });
});

describe("key issuance", () => {
  it("retires free API key issuance", async () => {
    const res = await post("/v1/keys", { label: "test agent" });
    expect(res.status).toBe(410);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("not_found");
  });
});

describe("package snapshot endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns snapshot data for a known package", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
        if (url.startsWith("https://api.deps.dev/v3/systems/npm/packages/express")) {
          return json({
            packageKey: { name: "express" },
            versions: [
              { versionKey: { version: "4.21.2" }, publishedAt: "2024-12-01T00:00:00Z", isDefault: false },
              { versionKey: { version: "5.1.0" }, publishedAt: "2025-03-31T00:00:00Z", isDefault: true },
            ],
          });
        }
        if (url.startsWith("https://api.osv.dev/v1/query")) return json({ vulns: [] });
        if (url.startsWith("https://endoflife.date/api/express.json")) {
          return json([{ cycle: "5", eol: false, latest: "5.1.0" }]);
        }
        return new Response("nf", { status: 404 });
      }),
    );
    const res = await app.request("/v1/package/npm/express", {}, env, fakeCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.latest_stable).toBe("5.1.0");
    expect(body.version_count).toBe(2);
    expect(body.eol).toMatchObject({ cycle: "5", eol: false });
  });

  it("404s for unknown packages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nf", { status: 404 })),
    );
    const res = await app.request("/v1/package/npm/definitely-not-real-xyz", {}, env, fakeCtx);
    expect(res.status).toBe(404);
  });
});
