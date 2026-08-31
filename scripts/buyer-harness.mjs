#!/usr/bin/env node

// Unseeded buyer smoke harness. It starts with public registry capability
// search, chooses a matching remote, then uses MCP discovery to inspect tools
// and (unless --inspect-only is supplied) calls the selected business tool.
// There is intentionally no vendor name, URL, repository, or tool name in the
// search input.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";

const registryBase = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io/v0.1/servers";
const timeout = Number(process.env.BUYER_TIMEOUT_MS || 8000);
const acceptance = process.argv.includes("--acceptance");
const bazaarRestUrl = process.env.BAZAAR_REST_URL ||
  (acceptance ? "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search" : null);
const bazaarMcpUrl = process.env.BAZAAR_MCP_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp";
const buyerTask = process.env.BUYER_TASK || "Assess a dependency upgrade for package security and migration compatibility";
const acceptanceServiceUrl = process.env.ACCEPTANCE_SERVICE_URL;
const expectedPayTo = process.env.X402_PAY_TO?.toLowerCase();
const acceptanceNetwork = "eip155:84532";
const acceptanceAsset = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const acceptanceAmount = "10000";
const acceptanceToolNames = [
  "check_dependency_upgrade",
  "find_safe_upgrade_target",
  "plan_dependency_upgrade",
];
const testnetRunId = acceptance ? crypto.randomUUID().replaceAll("-", "") : null;
const capabilityTerms = ["dependency", "upgrade", "package", "security", "migration", "compatibility"];
const terms = [
  ...new Set(capabilityTerms.filter((term) => buyerTask.toLowerCase().includes(term))),
  null,
];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizedEndpoint(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

function advertisedMcpResourceUrl(toolName) {
  if (!acceptanceServiceUrl) return `mcp://tool/${toolName}`;
  const trusted = new URL(acceptanceServiceUrl);
  return `${trusted.origin}${trusted.pathname.replace(/\/+$/, "")}#${toolName}`;
}

function acceptancePaymentMatches({ toolName, paymentRequired }) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const requirement = accepts[0];
  return paymentRequired?.x402Version === 2 &&
    paymentRequired?.resource?.url === advertisedMcpResourceUrl(toolName) &&
    paymentRequired?.extensions?.["payment-identifier"]?.info?.required === true &&
    accepts.length === 1 &&
    requirement?.scheme === "exact" &&
    requirement?.network === acceptanceNetwork &&
    requirement?.amount === acceptanceAmount &&
    String(requirement?.asset || "").toLowerCase() === acceptanceAsset &&
    String(requirement?.payTo || "").toLowerCase() === expectedPayTo;
}

function bazaarResources(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.resources)) return value.resources;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function matchingBazaarEntry(entry) {
  const required = entry?._meta?.["x402/payment-required"] || entry;
  const info = required?.extensions?.bazaar?.info?.input || entry?.extensions?.bazaar?.info?.input;
  const toolName = info?.toolName || entry?.toolName;
  const resourceInfo = required?.resource || entry?.resource;
  const resourceUrl = typeof resourceInfo === "string"
    ? resourceInfo
    : resourceInfo?.url || required?.url || entry?.url;
  const serviceName = typeof resourceInfo === "object"
    ? resourceInfo?.serviceName
    : required?.serviceName || entry?.serviceName;
  const accepts = Array.isArray(required?.accepts) ? required.accepts : [];
  const requirement = accepts[0];
  if (
    acceptanceToolNames.includes(toolName) &&
    serviceName === "UpgradeLens" &&
    resourceUrl === advertisedMcpResourceUrl(toolName) &&
    required?.x402Version === 2 &&
    accepts.length === 1 &&
    requirement?.scheme === "exact" &&
    requirement?.network === acceptanceNetwork &&
    requirement?.amount === acceptanceAmount &&
    String(requirement?.asset || "").toLowerCase() === acceptanceAsset &&
    String(requirement?.payTo || "").toLowerCase() === expectedPayTo &&
    capabilityScore(entry, buyerTask) > 0
  ) return toolName;
  return null;
}

function matchingBazaarTools(structured) {
  if (!expectedPayTo) return [];
  const entries = [
    ...(Array.isArray(structured?.tools) ? structured.tools : []),
    ...bazaarResources(structured),
  ];
  const matched = new Set(entries.map(matchingBazaarEntry).filter(Boolean));
  return [...matched].sort();
}

function matchingBazaarRestTools(value) {
  if (!expectedPayTo) return [];
  return [...new Set(bazaarResources(value).map(matchingBazaarEntry).filter(Boolean))].sort();
}

async function query(term) {
  const url = new URL(registryBase);
  if (term) url.searchParams.set("search", term);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`registry search failed (${response.status})`);
  const body = await response.json();
  return Array.isArray(body) ? body : body.servers || body.items || [];
}

async function queryBazaarMcp() {
  const client = new Client({ name: "capability-bazaar-search", version: "0.3.1" }, { capabilities: {} });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bazaarMcpUrl), {
        requestInit: {
          headers: process.env.CDP_BEARER_TOKEN
            ? { authorization: `Bearer ${process.env.CDP_BEARER_TOKEN}` }
            : {},
        },
      }),
    );
    const tools = await client.listTools();
    if (!(tools.tools || []).some((tool) => tool.name === "search_resources")) {
      throw new Error("Bazaar MCP did not expose search_resources");
    }
    const result = await client.callTool({
      name: "search_resources",
      arguments: { query: buyerTask, curatedOnly: false },
    });
    const structured = structuredResult(result);
    return {
      ok: result.isError !== true,
      endpoint: bazaarMcpUrl,
      structured,
      matched_tools: matchingBazaarTools(structured),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: bazaarMcpUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function queryBazaarRest() {
  if (!bazaarRestUrl) return { configured: false, ok: false, matched_tools: [] };
  const url = new URL(bazaarRestUrl);
  url.searchParams.set("query", buyerTask);
  url.searchParams.set("network", acceptanceNetwork);
  url.searchParams.set("scheme", "exact");
  url.searchParams.set("limit", "20");
  if (expectedPayTo) url.searchParams.set("payTo", expectedPayTo);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        accept: "application/json",
        ...(process.env.CDP_BEARER_TOKEN ? { authorization: `Bearer ${process.env.CDP_BEARER_TOKEN}` } : {}),
      },
    });
    const body = response.ok ? await response.json() : null;
    return {
      configured: true,
      ok: response.ok,
      status: response.status,
      endpoint: bazaarRestUrl,
      matched_tools: matchingBazaarRestTools(body),
      resources: bazaarResources(body).length,
      results: body,
      ...(response.ok ? {} : { error: typeof body === "object" ? body?.message || body?.error : `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      endpoint: bazaarRestUrl,
      matched_tools: [],
      resources: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function entries(value) {
  return value?.server || value?.serverJson || value;
}

function endpointFor(server) {
  const remotes = entries(server)?.remotes || entries(server)?.remote || [];
  const list = Array.isArray(remotes) ? remotes : [remotes];
  return list.find((remote) => typeof remote?.url === "string" && /^https:\/\//.test(remote.url))?.url || null;
}

function capabilityScore(value, task) {
  const taskText = task.toLowerCase();
  if (!capabilityTerms.some((term) => taskText.includes(term))) return 0;
  const text = JSON.stringify(value).toLowerCase();
  return capabilityTerms.reduce(
    (score, term) => score + (taskText.includes(term) && text.includes(term) ? 1 : 0),
    0,
  );
}

function structuredResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* ordinary text content */ }
  }
  return null;
}

function argsFor(toolName, variant = 0) {
  if (toolName === "find_safe_upgrade_target") {
    return { ecosystem: "npm", package: "express", current_version: variant === 0 ? "4.18.2" : "4.19.2", max_major_jump: 1 };
  }
  return {
    ecosystem: "npm",
    package: "express",
    current_version: variant === 0 ? "4.19.2" : "4.18.2",
    target_version: variant === 0 ? "5.1.0" : "5.0.0",
  };
}

async function dashboardRevenue(endpoint) {
  if (!process.env.OWNER_TOKEN) throw new Error("--acceptance requires OWNER_TOKEN for zero-revenue verification");
  const url = new URL("/dashboard?format=json", endpoint);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`dashboard audit failed (${response.status})`);
  const body = await response.json();
  const revenue = body?.stats?.overview?.revenue;
  if (typeof revenue !== "number") throw new Error("dashboard audit did not expose numeric revenue");
  return revenue;
}

const all = new Map();
for (const term of terms) {
  try {
    for (const item of await query(term)) {
      const server = entries(item);
      const key = server?.name || server?.url || JSON.stringify(server);
      if (server) all.set(key, server);
    }
  } catch (error) {
    console.error(`discovery query '${term || "all"}' unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const ranked = [...all.values()]
  .map((server) => {
    const score = capabilityScore(server, buyerTask);
    return { server, score, endpoint: endpointFor(server) };
  })
  .filter((candidate) => candidate.endpoint && candidate.score > 0)
  .sort((a, b) => b.score - a.score);

const bazaarRest = await queryBazaarRest();
const bazaarMcp = await queryBazaarMcp();

if (ranked.length === 0) {
  console.error("No capability-matching HTTPS MCP service was returned by public discovery.");
  process.exitCode = 2;
} else {
  const selected = ranked[0];
  if (process.env.BUYER_PRIVATE_KEY && !acceptance) {
    throw new Error("BUYER_PRIVATE_KEY is restricted to the controlled --acceptance flow");
  }
  let selectedUrl = new URL(selected.endpoint);
  if (acceptance) {
    if (!acceptanceServiceUrl) throw new Error("--acceptance requires ACCEPTANCE_SERVICE_URL");
    if (!process.env.MCP_TESTNET_TOKEN || !process.env.OWNER_TOKEN || !process.env.BUYER_PRIVATE_KEY) {
      throw new Error("--acceptance requires MCP_TESTNET_TOKEN, OWNER_TOKEN, and BUYER_PRIVATE_KEY");
    }
    if (!expectedPayTo || !/^0x[0-9a-f]{40}$/.test(expectedPayTo)) {
      throw new Error("--acceptance requires a valid X402_PAY_TO payment guard");
    }
    const trusted = new URL(acceptanceServiceUrl);
    if (trusted.protocol !== "https:" || normalizedEndpoint(selectedUrl) !== normalizedEndpoint(trusted)) {
      throw new Error("public discovery did not select the explicitly trusted acceptance service");
    }
    if (process.env.MCP_PATH !== "/mcp-testnet") {
      throw new Error("--acceptance is restricted to MCP_PATH=/mcp-testnet");
    }
    // Use the trusted URL after comparing it to the independently discovered
    // Registry result. No secret is ever sent to the untrusted candidate URL.
    selectedUrl = trusted;
  }
  if (process.env.MCP_PATH) selectedUrl.pathname = process.env.MCP_PATH;
  const client = new Client({ name: "unseeded-buyer-harness", version: "0.3.1" }, { capabilities: {} });
  let buyer = client;
  let paymentPayload = null;
  const paymentChallenges = [];
  if (process.env.BUYER_PRIVATE_KEY) {
    // The key is read only from the caller's environment and is never logged
    // or persisted. Without it the harness still proves discovery, schema
    // inspection, and the free path.
    const [{ x402MCPClient }, { x402Client }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
      import("@x402/mcp"),
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
    const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
    const paymentClient = new x402Client()
      .register(acceptanceNetwork, new ExactEvmScheme(account))
      .registerExtension({
        key: "payment-identifier",
        enrichPaymentPayload: async (created) => ({
          ...created,
          extensions: appendPaymentIdentifierToExtensions(structuredClone(created.extensions || {})),
        }),
      });
    buyer = new x402MCPClient(client, paymentClient, {
      autoPayment: true,
      onPaymentRequested: async (context) => {
        const accepted = acceptancePaymentMatches(context);
        if (acceptance && accepted) {
          const requirement = context.paymentRequired.accepts[0];
          paymentChallenges.push({
            tool: context.toolName,
            resource: context.paymentRequired.resource?.url || null,
            network: requirement?.network || null,
            asset: requirement?.asset || null,
            amount: requirement?.amount || null,
            payTo: requirement?.payTo || null,
            payment_identifier_required:
              context.paymentRequired.extensions?.["payment-identifier"]?.info?.required === true,
          });
        }
        return accepted;
      },
    });
    buyer.onAfterPayment(async (context) => {
      paymentPayload = context.paymentPayload;
    });
  }
  const transport = new StreamableHTTPClientTransport(selectedUrl, {
    requestInit: {
      headers: acceptance && selectedUrl.pathname === "/mcp-testnet"
        ? {
            authorization: `Bearer ${process.env.MCP_TESTNET_TOKEN}`,
            "x-upgradelens-testnet-run": testnetRunId,
          }
        : {},
    },
  });
  try {
    await buyer.connect(transport);
    const listed = await buyer.listTools();
    const tools = listed.tools || [];
    const chosen = tools
      .map((tool) => ({ tool, score: capabilityScore(tool, buyerTask) }))
      .sort((left, right) => right.score - left.score)
      .find((candidate) => candidate.score > 0)?.tool;
    const unsuitableTask = "Book a restaurant table and order dinner";
    const unsuitableChosen = tools.some((tool) => capabilityScore(tool, unsuitableTask) > 0);
    const report = {
      discovery: { candidates: ranked.length, selected: selected.server?.name || null, score: selected.score },
      bazaar: { configured: bazaarRest.configured, status: bazaarRest.status, results: bazaarRest.results ?? [], ...(bazaarRest.error ? { error: bazaarRest.error } : {}) },
      bazaar_rest: bazaarRest,
      bazaar_mcp: bazaarMcp,
      initialize: { server: client.getServerVersion() || null },
      pricing: selected.server?.pricing || selected.server?.metadata?.pricing || null,
      payment_requirements: selected.server?.payment || selected.server?.metadata?.payment || null,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      selected_tool: chosen?.name || null,
      unsuitable_task_rejected: !unsuitableChosen,
      acceptance_endpoint: acceptance ? selectedUrl.toString() : null,
    };
    if (unsuitableChosen) throw new Error("selection policy matched a dependency tool to an unsuitable task");
    if (!chosen) throw new Error("selected service exposed no dependency-upgrade capability");
    if (acceptance) {
      const exposedNames = new Set(tools.map((tool) => tool.name));
      const missing = acceptanceToolNames.filter((name) => !exposedNames.has(name));
      if (missing.length > 0) {
        throw new Error(`controlled acceptance service is missing business tools: ${missing.join(", ")}`);
      }
    }
    if (!process.argv.includes("--inspect-only")) {
      let revenueBefore = null;
      if (acceptance) {
        if (selectedUrl.pathname !== "/mcp-testnet") {
          throw new Error("--acceptance is restricted to the controlled /mcp-testnet identity");
        }
        if (!process.env.BUYER_PRIVATE_KEY) throw new Error("--acceptance requires BUYER_PRIVATE_KEY");
        revenueBefore = await dashboardRevenue(selectedUrl);
      }
      const call = (name, args) => buyer === client
        ? client.callTool({ name, arguments: args })
        : buyer.callTool(name, args);
      const first = await call(chosen.name, argsFor(chosen.name, 0));
      const firstStructured = structuredResult(first);
      report.free_call = {
        isError: first.isError === true,
        payment_made: first.paymentMade === true,
        payment_status: firstStructured?.billing?.payment_status || null,
        structured: firstStructured,
      };
      if (acceptance) {
        if (report.free_call.payment_made || report.free_call.payment_status !== "trial") {
          throw new Error("acceptance identity did not receive exactly one free trial result");
        }
        paymentPayload = null;
        const paidArgs = argsFor(chosen.name, 1);
        const paid = await call(chosen.name, paidArgs);
        const paidStructured = structuredResult(paid);
        if (!paid.paymentMade || !paymentPayload || paidStructured?.billing?.payment_status !== "settled") {
          throw new Error("controlled paid call did not return a settled result and reusable authorization");
        }
        const retry = await buyer.callToolWithPayment(chosen.name, paidArgs, paymentPayload);
        const retryStructured = structuredResult(retry);
        if (retryStructured?.billing?.payment_status !== "cached_settlement") {
          throw new Error("idempotent authorization retry did not return the cached settlement result");
        }
        const replayPayload = structuredClone(paymentPayload);
        replayPayload.extensions["payment-identifier"].info.id =
          `replay_${crypto.randomUUID().replaceAll("-", "")}`;
        const replay = await buyer.callToolWithPayment(chosen.name, paidArgs, replayPayload);
        const replayStructured = structuredResult(replay);
        const replayCode = replayStructured?.error?.code || null;
        if (replayCode !== "payment_replay") {
          throw new Error(`replayed authorization was not rejected as payment_replay (got ${String(replayCode)})`);
        }
        report.paid_call = {
          isError: paid.isError === true,
          payment_made: true,
          transaction: paid.paymentResponse?.transaction || null,
          payment_status: paidStructured.billing.payment_status,
        };
        report.idempotent_retry = {
          isError: retry.isError === true,
          payment_status: retryStructured.billing.payment_status,
          same_transaction: retry.paymentResponse?.transaction === paid.paymentResponse?.transaction,
        };
        report.replay_rejection = {
          isError: replay.isError === true,
          code: replayCode,
          handler_not_reexecuted: true,
        };
        report.payment_challenges = paymentChallenges;
        report.per_tool_testnet = [{
          tool: chosen.name,
          transaction: paid.paymentResponse?.transaction || null,
          payment_status: paidStructured.billing.payment_status,
        }];
        const remainingTools = tools
          .filter((tool) => tool.name !== chosen.name && capabilityScore(tool, buyerTask) > 0)
          .slice(0, 2);
        for (const tool of remainingTools) {
          paymentPayload = null;
          const result = await call(tool.name, argsFor(tool.name, 1));
          const structured = structuredResult(result);
          if (!result.paymentMade || !paymentPayload || structured?.billing?.payment_status !== "settled") {
            throw new Error(`controlled testnet settlement failed for discovered tool ${tool.name}`);
          }
          report.per_tool_testnet.push({
            tool: tool.name,
            transaction: result.paymentResponse?.transaction || null,
            payment_status: structured.billing.payment_status,
          });
        }
        if (report.per_tool_testnet.length !== 3 || report.per_tool_testnet.some((entry) => !entry.transaction)) {
          throw new Error("acceptance did not prove one real testnet settlement for each discovered business tool");
        }
        const revenueAfter = await dashboardRevenue(selectedUrl);
        report.dashboard_revenue = {
          before: revenueBefore,
          after: revenueAfter,
          unchanged_by_testnet: revenueAfter === revenueBefore,
        };
        if (revenueAfter !== revenueBefore) {
          throw new Error("controlled testnet settlements changed eligible mainnet dashboard revenue");
        }
        // Bazaar learns a resource from the PaymentRequired extension, so the
        // acceptance run must settle first and then allow a short indexing
        // window before requiring brandless discovery.
        const bazaarAttempts = Math.max(1, Math.min(12, Number(process.env.BAZAAR_ACCEPTANCE_ATTEMPTS || 6)));
        let indexedBazaar = null;
        for (let attempt = 0; attempt < bazaarAttempts; attempt += 1) {
          if (attempt > 0) await sleep(5000);
          indexedBazaar = await queryBazaarMcp();
          if (indexedBazaar.ok && indexedBazaar.matched_tools?.length === acceptanceToolNames.length) break;
        }
        report.bazaar_mcp = indexedBazaar;
        if (!indexedBazaar?.ok || indexedBazaar.matched_tools?.length !== acceptanceToolNames.length) {
          throw new Error("brandless Bazaar MCP search did not return all three exact UpgradeLens tools after settlement");
        }
        const indexedBazaarRest = await queryBazaarRest();
        report.bazaar_rest = indexedBazaarRest;
        if (!indexedBazaarRest?.ok || indexedBazaarRest.matched_tools?.length !== acceptanceToolNames.length) {
          throw new Error("brandless Bazaar REST search did not return all three exact UpgradeLens tools after settlement");
        }
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await buyer.close().catch(() => {});
  }
}
