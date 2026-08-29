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
  });

  it("falls back to latest supported protocol for unknown versions", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-06-18");
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
    expect(find.description).toMatch(/candidates are not declared safe/i);
    expect(plan.description).toMatch(/migration checklist.*refactor actions.*ordered review actions/s);
    expect(plan.description).toMatch(/Use check_dependency_upgrade instead/);
    expect(check.inputSchema.properties.runtime.additionalProperties).toBe(false);
  });

  it("rejects browser requests from unapproved origins", async () => {
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
    expect(res.status).toBe(403);
  });

  it("rejects unsupported protocol headers", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 32, method: "tools/list" }),
      },
      env,
      fakeCtx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects JSON-RPC batches", async () => {
    const res = await rpc([{ jsonrpc: "2.0", id: 33, method: "ping" }]);
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

  it("returns isError result for invalid tool arguments (not a protocol error)", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "check_dependency_upgrade", arguments: { ecosystem: "cargo", package: "x" } },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toMatch(/Unsupported ecosystem/);
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
