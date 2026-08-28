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

  it("serves llms.txt mentioning the MCP endpoint", async () => {
    const res = await app.request("/llms.txt", {}, env, fakeCtx);
    const text = await res.text();
    expect(text).toMatch(/\/mcp/);
    expect(text).toMatch(/check_dependency_upgrade/);
  });

  it("serves pricing.json in free_validation mode with $0 posture", async () => {
    const res = await app.request("/pricing.json", {}, env, fakeCtx);
    const body = (await res.json()) as any;
    expect(body.mode).toBe("free_validation");
    expect(body.paid.status).toBe("blocked_pending_payment_implementation");
    expect(body.payment_activation.ready).toBe(false);
  });

  it("healthz responds", async () => {
    const res = await app.request("/healthz", {}, env, fakeCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.service).toBe("upgradelens");
  });

  it("landing page is served with MCP config snippet", async () => {
    const res = await app.request("/", {}, env, fakeCtx);
    const html = await res.text();
    expect(html).toMatch(/mcpServers/);
  });
});

describe("dashboard auth", () => {
  it("requires the owner token", async () => {
    const res = await app.request("/dashboard", {}, env, fakeCtx);
    expect(res.status).toBe(401);
  });
  it("accepts the owner token", async () => {
    const res = await app.request("/dashboard?token=test-owner-token", {}, env, fakeCtx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/NO SIGNAL|EARLY SIGNAL|owner dashboard/);
    expect(html).toMatch(/\$0\.00/);
  });
  it("503s when no owner token is configured", async () => {
    const res = await app.request("/dashboard?token=x", {}, fakeEnv({ OWNER_TOKEN: undefined }), fakeCtx);
    expect(res.status).toBe(503);
  });
});

describe("key issuance", () => {
  it("creates a free API key", async () => {
    const res = await post("/v1/keys", { label: "test agent" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.key).toMatch(/^ul_[a-z0-9]{24}$/);
    expect(body.plan).toBe("free");
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
