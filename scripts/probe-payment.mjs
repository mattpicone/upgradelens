#!/usr/bin/env node

// No-payment probe: confirms the MCP protocol remains discoverable and that a
// paid mode returns a retryable PaymentRequired result. It never signs,
// settles, or retries with payment.
const service = (process.env.SERVICE_URL || "https://upgradelens.mattpicone.workers.dev").replace(/\/$/, "");
const path = process.env.MCP_PATH || "/mcp";
const testnetToken = process.env.MCP_TESTNET_TOKEN;
const response = await fetch(`${service}${path}`, {
  method: "POST",
  signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS || 8000)),
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    "user-agent": "UpgradeLens-Payment-Probe/1.0",
    "x-upgradelens-payment-probe": "true",
    ...(testnetToken && path === "/mcp-testnet" ? { authorization: `Bearer ${testnetToken}` } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "check_dependency_upgrade",
      arguments: { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0" },
    },
  }),
});
const text = await response.text();
let body = null;
try { body = JSON.parse(text); } catch { /* stream transports may wrap JSON */ }
const result = body?.result || body;
const challenge = result?.structuredContent;
const hasChallenge = result?.isError === true &&
  challenge?.x402Version === 2 &&
  Array.isArray(challenge.accepts) &&
  challenge.accepts.some((requirement) => requirement?.scheme === "exact" && requirement?.amount === "10000") &&
  Boolean(challenge.extensions?.["payment-identifier"]);
console.log(JSON.stringify({ service: `${service}${path}`, http_status: response.status, payment_challenge: hasChallenge, result }, null, 2));
if (!response.ok && response.status >= 500) process.exitCode = 1;
if (process.env.EXPECT_PAYMENT_CHALLENGE === "true" && !hasChallenge) process.exitCode = 1;
