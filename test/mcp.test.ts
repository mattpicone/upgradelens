// MCP protocol tests: initialize, tools/list, tools/call, error paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { fakeEnv, fakeCtx } from "./helpers";

const env = fakeEnv();

function rpc(body: unknown) {
  return app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    fakeCtx,
  );
}

describe("MCP protocol", () => {
  it("responds to initialize with server info and echoes supported protocol", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("upgradelens");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toMatch(/If current_version is unknown, read the project manifest first/);
    expect(body.result.instructions).toMatch(/if the target is unknown, call find_safe_upgrade_target then check_dependency_upgrade or plan_dependency_upgrade/);
    expect(body.result.instructions).toMatch(/action_allowed=true/);
  });

  it("falls back to latest supported protocol for unknown versions", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("accepts notifications/initialized with 202 and no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("lists exactly three tools with use-when descriptions", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const body = (await res.json()) as any;
    const tools = body.result.tools;
    expect(tools).toHaveLength(3);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "check_dependency_upgrade",
      "find_safe_upgrade_target",
      "plan_dependency_upgrade",
    ]);
    for (const t of tools) {
      expect(t.description).toMatch(/Use (?:only )?when|Use after/);
      expect(t.description).toMatch(/Do not use/);
      expect(t.description).toMatch(/Read-only and safe to retry/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.outputSchema.type).toBe("object");
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    const check = tools.find((t: any) => t.name === "check_dependency_upgrade");
    const find = tools.find((t: any) => t.name === "find_safe_upgrade_target");
    const plan = tools.find((t: any) => t.name === "plan_dependency_upgrade");
    expect(check.description).toMatch(/go\/no-go.*without steps|go\/no-go risk decision/s);
    expect(check.description).toMatch(/Use plan_dependency_upgrade instead/);
    expect(find.title).not.toMatch(/Find a safe/i);
    expect(find.title).toMatch(/not a safety verdict/i);
    expect(find.description).toMatch(/candidates are not declared safe/i);
    expect(find.inputSchema.properties.ecosystem.description).toMatch(/npm and pypi/i);
    expect(find.inputSchema.properties.max_major_jump.description).toMatch(/0 = stay in the same major/);
    expect(check.outputSchema.properties.version_facts).toBeDefined();
    expect(check.outputSchema.properties.security_delta).toBeDefined();
    expect(check.outputSchema.properties.compatibility).toBeDefined();
    expect(check.outputSchema.properties.breaking_changes).toBeDefined();
    expect(find.outputSchema.properties.candidates.items.properties.score).toBeDefined();
    expect(find.outputSchema.properties.candidates.items.properties.fixes_advisories).toBeDefined();
    expect(find.outputSchema.properties.candidates.items.properties.introduces_advisories).toBeDefined();
    expect(plan.description).toMatch(/migration checklist.*refactor actions.*ordered review actions/s);
    expect(plan.description).toMatch(/Use check_dependency_upgrade instead/);
    expect(check.inputSchema.properties.runtime.additionalProperties).toBe(false);
  });

  it("allows valid browser and Electron origins on the public MCP endpoint", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/list" }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://attacker.example");

    const opaque = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "null" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 32, method: "tools/list" }),
      },
      env,
      fakeCtx,
    );
    expect(opaque.status).toBe(200);
    expect(opaque.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("rejects malformed Origin headers", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "not a serialized origin" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 33, method: "tools/list" }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(403);
  });

  it("answers browser CORS preflight without consuming an MCP request body", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://cursor.com",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name",
        },
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://cursor.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
  });

  it("returns supported versions so clients can negotiate an unknown protocol header", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 34, method: "tools/list" }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.requested).toBe("1999-01-01");
    expect(body.error.data.supported).toEqual(
      expect.arrayContaining(["2026-07-28", "2025-11-25", "2025-06-18"]),
    );
  });

  it("supports current stateless discovery and tool listing with mirrored headers", async () => {
    const params = {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "current-client", version: "1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
    const discover = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 35, method: "server/discover", params }),
      },
      env,
      fakeCtx,
    );
    expect(discover.status).toBe(200);
    const discovered = (await discover.json()) as any;
    expect(discovered.result.resultType).toBe("complete");
    expect(discovered.result.supportedVersions).toContain("2026-07-28");
    expect(discovered.result.capabilities.tools).toBeDefined();

    const listed = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 36, method: "tools/list", params }),
      },
      env,
      fakeCtx,
    );
    const body = (await listed.json()) as any;
    expect(body.result.resultType).toBe("complete");
    expect(body.result.tools).toHaveLength(3);
    expect(body.result.cacheScope).toBe("public");
  });

  it("rejects mismatched current-protocol routing headers", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 37,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "current-client", version: "1.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32020);
  });

  it("rejects JSON-RPC batches", async () => {
    const res = await rpc([{ jsonrpc: "2.0", id: 38, method: "ping" }]);
    expect(res.status).toBe(400);
  });

  it("returns method not found for unknown methods", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 4, method: "bogus/method" });
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32601);
  });

  it("rejects malformed JSON with a parse error", async () => {
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32700);
  });

  it("refuses GET (no server-initiated streams on a stateless server)", async () => {
    const res = await app.request("/mcp", { method: "GET" }, env, fakeCtx);
    expect(res.status).toBe(405);
  });

  it("does not expose the controlled testnet identity unless explicitly configured", async () => {
    const res = await app.request("/mcp-testnet", { method: "POST" }, env, fakeCtx);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error.code).toBe("not_found");
  });

  it("keeps the challenge-only probe from entering the validation handler", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-upgradelens-payment-probe": "true", "user-agent": "UpgradeLens-Payment-Probe/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "check_dependency_upgrade", arguments: { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0" } } }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe("payment_service_unavailable");
  });

  it("returns isError result for invalid tool arguments (not a protocol error)", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "check_dependency_upgrade", arguments: { ecosystem: "cargo", package: "x" } },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.message).toMatch(/Unsupported ecosystem/);
  });

  it("returns isError for unknown tool names", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "do_everything", arguments: {} },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
  });
});

describe("MCP tools/call end-to-end (mocked upstreams)", () => {
  beforeEach(() => {
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
              { versionKey: { version: "1.2.0" }, publishedAt: "2018-01-01T00:00:00Z", isDefault: false },
              { versionKey: { version: "1.3.0" }, publishedAt: "2018-04-01T00:00:00Z", isDefault: true },
            ],
          });
        }
        if (url.startsWith("https://registry.npmjs.org/left-pad/")) {
          const version = url.split("/").pop();
          return json({ version, dependencies: {}, license: "WTFPL" });
        }
        if (url.startsWith("https://api.osv.dev/v1/querybatch")) {
          return json({ results: [{}, {}] });
        }
        return new Response("nf", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("check_dependency_upgrade returns structured decision content", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 10,
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
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(false);
    const sc = body.result.structuredContent;
    expect(sc.decision).toBe("proceed");
    expect(sc.version_facts.semver_jump).toBe("minor");
    expect(Array.isArray(sc.evidence)).toBe(true);
    // text content mirrors structured content for older clients
    expect(JSON.parse(body.result.content[0].text).decision).toBe("proceed");
  });

  it("serves a current-protocol tools/call with mirrored method and tool headers", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "check_dependency_upgrade",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "current-client", version: "1.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
            name: "check_dependency_upgrade",
            arguments: {
              ecosystem: "npm",
              package: "left-pad",
              current_version: "1.2.0",
              target_version: "1.3.0",
            },
          },
        }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.resultType).toBe("complete");
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.decision).toBe("proceed");
  });

  it("plan_dependency_upgrade includes migration actions", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "plan_dependency_upgrade",
        arguments: {
          ecosystem: "npm",
          package: "left-pad",
          current_version: "1.2.0",
          target_version: "1.3.0",
        },
      },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(false);
    const sc = body.result.structuredContent;
    expect(sc.migration_actions.length).toBeGreaterThan(0);
    expect(sc.changelog_urls.length).toBeGreaterThan(0);
  });

  it("find_safe_upgrade_target ranks candidates", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "find_safe_upgrade_target",
        arguments: { ecosystem: "npm", package: "left-pad", current_version: "1.2.0" },
      },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(false);
    const sc = body.result.structuredContent;
    expect(sc.candidates.length).toBeGreaterThan(0);
    expect(sc.candidates[0].version).toBe("1.3.0");
    expect(sc.candidates[0].rationale.length).toBeGreaterThan(0);
    expect(sc.candidates[0].requires_full_check).toBe(true);
    expect(sc.candidates[0].decision).not.toBe("proceed");
  });
});
