#!/usr/bin/env node

// Owner-only production smoke test. It is deliberately gated by the clean
// telemetry schema and uses an owner token, so these calls are observable as
// internal verification and can never become business demand.

const SERVICE_URL = (process.env.SERVICE_URL || "https://upgradelens.mattpicone.workers.dev").replace(/\/$/, "");
const OWNER_TOKEN = process.env.OWNER_TOKEN;
const USER_AGENT = "UpgradeLens-Owner-Verification/1.0";
const EXPECTED_TOOLS = [
  "check_dependency_upgrade",
  "find_safe_upgrade_target",
  "plan_dependency_upgrade",
];

if (!OWNER_TOKEN) {
  console.error("OWNER_TOKEN is required; refusing to send verification traffic without owner classification.");
  process.exit(2);
}

async function jsonFetch(path, init = {}) {
  let response;
  try {
    response = await fetch(`${SERVICE_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`${path} network failure: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status})`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return body;
}

try {
  const health = await jsonFetch("/healthz");
  if (health?.db !== "ok" || health?.telemetry_schema !== "ok") {
    throw new Error(
      `Refusing MCP verification until DB and telemetry schema are healthy (db=${health?.db ?? "missing"}, telemetry_schema=${health?.telemetry_schema ?? "missing"})`,
    );
  }

let nextId = 1;
async function mcp(method, params = {}) {
  const body = await jsonFetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (body?.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  if (!body?.result) throw new Error(`${method} returned no result`);
  return body.result;
}

const initialized = await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "upgradelens-owner-verifier", version: "1.0" },
});
const listed = await mcp("tools/list");
const names = (listed.tools || []).map((tool) => tool.name).sort();
if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort())) {
  throw new Error(`Unexpected production tools/list: ${names.join(",")}`);
}

const knownPair = {
  ecosystem: "npm",
  package: "express",
  current_version: "4.19.2",
  target_version: "5.1.0",
  runtime: { node: "20.11.0" },
};
const calls = [
  ["check_dependency_upgrade", knownPair],
  ["find_safe_upgrade_target", { ecosystem: "npm", package: "express", current_version: "4.19.2" }],
  ["plan_dependency_upgrade", knownPair],
];
const results = [];
for (const [name, arguments_] of calls) {
  const result = await mcp("tools/call", { name, arguments: arguments_ });
  if (result.isError === true) throw new Error(`${name} returned an MCP error result`);
  const structured = result.structuredContent || {};
  results.push({
    tool: name,
    decision: structured.decision ?? null,
    candidates: Array.isArray(structured.candidates) ? structured.candidates.length : null,
  });
}

const dashboard = await jsonFetch("/dashboard?format=json", {
  headers: { authorization: `Bearer ${OWNER_TOKEN}` },
});
const funnel = dashboard?.funnel || {};
  console.log(
    JSON.stringify(
      {
        service: SERVICE_URL,
        health: { db: health.db, telemetry_schema: health.telemetry_schema },
        initialized_protocol: initialized.protocolVersion,
        tools_list: names,
        calls: results,
        business_state: dashboard?.business_state?.state ?? null,
        internal_verification_calls: funnel.known_tool_invocations ?? null,
        genuine_business_calls: funnel.successful_business_calls ?? null,
        genuine_tool_clients: funnel.genuine_tool_clients ?? null,
        repeat_genuine_tool_clients: funnel.repeat_genuine_tool_clients ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Production MCP verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
