#!/usr/bin/env node

// Offline contract gate. Every discoverable manifest and the Worker config
// must carry the same immutable machine version before a release is published.
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const expected = "0.3.1";
const typedContract = await import(new URL("src/contract.ts", root));
const json = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const text = async (name) => readFile(new URL(name, root), "utf8");

const [pkg, server, plugin, gemini, mcp, copilot, wrangler, contract] = await Promise.all([
  json("package.json"),
  json("server.json"),
  json("plugin.json"),
  json("gemini-extension.json"),
  json("mcp.json"),
  json(".mcp.json"),
  text("wrangler.toml"),
  text("src/contract.ts"),
]);

const versions = {
  package: pkg.version,
  server: server.version,
  plugin: plugin.version,
  gemini: gemini.version,
  contract: contract.match(/CONTRACT_VERSION\s*=\s*"([^"]+)"/)?.[1] || null,
  worker: wrangler.match(/SERVICE_VERSION\s*=\s*"([^"]+)"/)?.[1] || null,
};
const failures = Object.entries(versions)
  .filter(([, version]) => version !== expected)
  .map(([name, version]) => `${name}=${String(version)} (expected ${expected})`);
if (mcp.mcpServers?.upgradelens?.url !== server.remotes?.[0]?.url) failures.push("mcp.json endpoint drift");
if (copilot.mcpServers?.upgradelens?.url !== server.remotes?.[0]?.url) failures.push(".mcp.json endpoint drift");
const generatedRegistry = typedContract.registryMetadata({ PUBLIC_BASE_URL: server.websiteUrl });
if (JSON.stringify(server) !== JSON.stringify(generatedRegistry)) failures.push("server.json drift from typed Registry metadata");
const generatedPricing = typedContract.pricingDocument({
  PUBLIC_BASE_URL: server.websiteUrl,
  PAYMENT_MODE: "validation",
  PAYMENTS_ENABLED: "false",
});
if (generatedPricing.unit?.price_usd !== 0.01 || generatedPricing.unit?.atomic_usdc !== "10000") {
  failures.push("typed pricing drift from exact $0.01/10,000 atomic USDC contract");
}
for (const dependency of ["@x402/core", "@x402/evm", "@x402/extensions"]) {
  if (pkg.dependencies?.[dependency] !== "2.24.0") failures.push(`${dependency} is not pinned at 2.24.0`);
}
if (pkg.devDependencies?.["@x402/mcp"] !== "2.24.0") failures.push("@x402/mcp is not pinned at 2.24.0");
if (JSON.stringify({ pkg, server, plugin, gemini, mcp, copilot }).match(/authorization|bearer|api[_-]?key|secret/i)) {
  failures.push("discoverable manifests contain credential-like fields");
}

console.log(JSON.stringify({ expected, versions, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
