import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

describe("free discovery manifests", () => {
  it("declares a Gemini CLI remote extension without credentials", () => {
    const manifest = readJson("gemini-extension.json");
    expect(manifest.name).toBe("upgradelens");
    expect(manifest.mcpServers.upgradelens.httpUrl).toBe("https://upgradelens.mattpicone.workers.dev/mcp");
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
      url: "https://upgradelens.mattpicone.workers.dev/mcp",
    });
    expect(JSON.stringify({ plugin, mcp })).not.toMatch(/authorization|bearer|api[_-]?key|secret/i);
  });
});
