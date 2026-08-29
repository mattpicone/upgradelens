import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { app } from "../src/index.ts";
import { MCP_TOOLS } from "../src/mcp/server.ts";
import { fakeEnv, fakeCtx } from "./helpers.ts";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
const PRODUCTION_MCP = "https://upgradelens.mattpicone.workers.dev/mcp";
const EXPECTED_TOOLS = [
  "check_dependency_upgrade",
  "find_safe_upgrade_target",
  "plan_dependency_upgrade",
];

describe("free discovery manifests", () => {
  it("declares a Gemini CLI remote extension without credentials", () => {
    const manifest = readJson("gemini-extension.json");
    expect(manifest.name).toBe("upgradelens");
    expect(manifest.mcpServers.upgradelens.httpUrl).toBe(PRODUCTION_MCP);
    expect(manifest.mcpServers.upgradelens.timeout).toBe(30000);
    expect(manifest.mcpServers.upgradelens).not.toHaveProperty("headers");
  });

  it("keeps Agent Plugins 1.0 manifests portable and secret-free", () => {
    const plugin = readJson("plugin.json");
    const mcp = readJson("mcp.json");
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.name).toBe("upgradelens");
    expect(plugin.keywords).toEqual(expect.arrayContaining(["dependency-upgrades", "mcp"]));
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(mcp.mcpServers.upgradelens).toEqual({
      type: "streamable-http",
      url: PRODUCTION_MCP,
    });
    expect(JSON.stringify({ plugin, mcp })).not.toMatch(/authorization|bearer|api[_-]?key|secret/i);
  });

  it("keeps Worker discovery paths, endpoint URL, and the three tool names from drifting", async () => {
    const env = fakeEnv();
    const base = env.PUBLIC_BASE_URL;
    const liveMcp = `${base}/mcp`;
    const toolNames = MCP_TOOLS.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());

    const mcpRes = await app.request("/mcp.json", {}, env, fakeCtx);
    expect(mcpRes.status).toBe(200);
    expect(mcpRes.headers.get("cache-control")).toMatch(/max-age=3600/);
    const mcp = await mcpRes.json();
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(mcp.mcpServers.upgradelens).toEqual({
      type: "streamable-http",
      url: liveMcp,
    });

    const serverRes = await app.request("/server.json", {}, env, fakeCtx);
    expect(serverRes.status).toBe(200);
    expect(serverRes.headers.get("cache-control")).toMatch(/max-age=3600/);
    const server = await serverRes.json();
    expect(server.remotes).toEqual([{ type: "streamable-http", url: liveMcp }]);
    expect(server.websiteUrl).toBe(base);

    const cardRes = await app.request("/.well-known/mcp/server-card.json", {}, env, fakeCtx);
    expect(cardRes.status).toBe(200);
    expect(cardRes.headers.get("cache-control")).toMatch(/max-age=3600/);
    const card = await cardRes.json();
    expect(card.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    );
    expect(card.remotes[0]).toMatchObject({ type: "streamable-http", url: liveMcp });
    expect(card._meta["io.github.mattpicone/upgradelens"].ratified).toBe(false);
    expect(card._meta["io.github.mattpicone/upgradelens"].ecosystems).toEqual(["npm", "pypi"]);
    expect(card._meta["io.github.mattpicone/upgradelens"].tools.map((t) => t.name).sort()).toEqual(
      toolNames,
    );
    expect(
      card._meta["io.github.mattpicone/upgradelens"].tools.every((t) => t.annotations.readOnlyHint),
    ).toBe(true);
    expect(JSON.stringify(card)).toMatch(/experimental-ext-server-card/);
    expect(card._meta["io.github.mattpicone/upgradelens"].note).toMatch(/not a ratified/i);

    const aliasRes = await app.request("/.well-known/mcp.json", {}, env, fakeCtx);
    expect(aliasRes.status).toBe(200);
    expect(aliasRes.headers.get("cache-control")).toMatch(/max-age=3600/);
    const alias = await aliasRes.json();
    expect(alias.url).toBe(liveMcp);
    expect(alias.transport).toBe("streamable-http");
    expect(alias.server_card).toBe(`${base}/.well-known/mcp/server-card.json`);

    const health = await app.request("/healthz", {}, env, fakeCtx);
    expect(health.headers.get("cache-control")).toMatch(/no-store/);
  });
});
