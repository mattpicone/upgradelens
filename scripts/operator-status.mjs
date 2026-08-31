#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const base = (process.env.PUBLIC_BASE_URL || "https://upgradelens.mattpicone.workers.dev").replace(/\/$/, "");
const timeoutMs = Number(process.env.STATUS_TIMEOUT_MS || 5000);

async function read(path) {
  try { return await readFile(new URL(path, root), "utf8"); } catch { return ""; }
}

function command(command, args) {
  const result = spawnSync(command, args, { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

async function fetchJson(url) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON health failure */ }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

const [pkg, server, plugin, gemini, wrangler, contractSource] = await Promise.all([
  read("package.json").then((value) => JSON.parse(value || "{}")),
  read("server.json").then((value) => JSON.parse(value || "{}")),
  read("plugin.json").then((value) => JSON.parse(value || "{}")),
  read("gemini-extension.json").then((value) => JSON.parse(value || "{}")),
  read("wrangler.toml"),
  read("src/contract.ts"),
]);
const versions = {
  package: pkg.version || null,
  server: server.version || null,
  plugin: plugin.version || null,
  gemini: gemini.version || null,
  contract: contractSource.match(/CONTRACT_VERSION\s*=\s*"([^"]+)"/)?.[1] || null,
  wrangler: wrangler.match(/SERVICE_VERSION\s*=\s*"([^"]+)"/)?.[1] || null,
};
const versionConsistent = Object.values(versions).every((v) => v === versions.package && v === "0.3.0");
const git = command("git", ["status", "--short"]);
const tests = command("npm", ["test"]);
const health = await fetchJson(`${base}/healthz`);
const pricing = await fetchJson(`${base}/pricing.json`);
const openapi = await fetchJson(`${base}/openapi.json`);
const registryUrl = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io/v0.1/servers?search=upgrade&limit=100";
const registry = await fetchJson(registryUrl);
const registryText = JSON.stringify(registry.body || {}).toLowerCase();
const registryIndexed = registry.ok &&
  registryText.includes("io.github.mattpicone/upgradelens") &&
  /\"version\"\s*:\s*\"0\.3\.0\"/.test(registryText);
const bazaar = process.env.BAZAAR_STATUS_URL
  ? await fetchJson(process.env.BAZAAR_STATUS_URL)
  : process.env.BAZAAR_STATE
    ? { ok: true, status: 200, body: { state: process.env.BAZAAR_STATE } }
    : { ok: false, status: 0, error: "BAZAAR_STATUS_URL/BAZAAR_STATE not configured" };

const activation = pricing.body?.payment_activation || null;
const checks = {
  contract_version: { ok: versionConsistent, detail: versions },
  tests: { ok: tests.ok, detail: tests.ok ? "passed" : tests.output.slice(-1200) },
  public_health: { ok: health.ok && health.body?.service === "upgradelens" && health.body?.version === "0.3.0", detail: health.status },
  openapi: { ok: openapi.ok && openapi.body?.info?.version === "0.3.0", detail: openapi.status },
  pricing: { ok: pricing.ok && pricing.body?.version === "0.3.0" && pricing.body?.unit?.price_usd === 0.01 && pricing.body?.unit?.atomic_usdc === "10000", detail: pricing.status },
  registry: { ok: registryIndexed, detail: registryIndexed ? "indexed" : registry.error || registry.status },
  bazaar: { ok: bazaar.ok, detail: bazaar.ok ? "reachable" : bazaar.error || bazaar.status },
  payment_activation: { ok: activation?.ready === true || activation?.mode === "validation", detail: activation },
};
const next = !checks.contract_version.ok ? "align immutable 0.3.0 manifests"
  : !checks.tests.ok ? "fix the local test suite"
  : !checks.public_health.ok ? "deploy and verify /healthz"
  : !checks.registry.ok ? "publish/verify the immutable MCP Registry version"
  : !checks.bazaar.ok ? "configure and verify a public Bazaar status endpoint"
  : activation?.mode === "mainnet" && activation?.ready !== true ? "resolve mainnet fail-closed blockers"
  : activation?.mode !== "validation" && activation?.ready !== true ? "provide testnet/payment facilitator prerequisites"
  : "all locally checkable gates pass; observe an external paid settlement before mainnet claims";

const report = {
  generated_at: new Date().toISOString(),
  base,
  checks,
  payment_mode: activation?.mode || process.env.PAYMENT_MODE || "unknown",
  next_unmet_gate: next,
  git: { clean: git.output.length === 0, status: git.output },
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`UpgradeLens operator status (${base})`);
  for (const [name, check] of Object.entries(checks)) console.log(`${check.ok ? "PASS" : "WAIT"} ${name}: ${typeof check.detail === "string" ? check.detail : JSON.stringify(check.detail)}`);
  console.log(`NEXT: ${next}`);
}
if (process.argv.includes("--strict") && Object.entries(checks).some(([name, check]) =>
  ["contract_version", "tests", "public_health", "openapi", "pricing", "registry"].includes(name) && !check.ok)) {
  process.exitCode = 1;
}
