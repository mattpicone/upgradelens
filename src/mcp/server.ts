// Remote MCP server — stateless Streamable HTTP transport.
// Single-response JSON mode: every POST carries one JSON-RPC message (or batch)
// and receives application/json back. No session state is required because all
// tools are pure read-only lookups, which keeps the free-tier footprint minimal.

import type { Context } from "hono";
import type { Env, UpgradeCheckRequest } from "../types";
import {
  validateCheckRequest,
  validateEcosystem,
  validatePackageName,
  validateVersion,
  ValidationError,
} from "../validate";
import { checkUpgrade, planUpgrade, findTarget } from "../service";
import type { AppVariables } from "../context";
import { readJsonBody } from "../http/body";
import { executeAnalysis } from "../payment";
import { MachineError, machineError } from "../errors";
import { CONTRACT_VERSION, MCP_BUSINESS_TOOL_NAMES, MCP_TOOLS, mcpToolResourceUrl } from "../contract";
import { checkRateLimit, classifyMcpSource } from "../telemetry";

export { MCP_BUSINESS_TOOL_NAMES, MCP_TOOLS } from "../contract";

export const MCP_SUPPORTED_PROTOCOLS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const SUPPORTED_PROTOCOLS: readonly string[] = MCP_SUPPORTED_PROTOCOLS;
const MODERN_PROTOCOL = "2026-07-28";
const LATEST_LEGACY_PROTOCOL = "2025-11-25";
const LEGACY_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);

const MCP_INSTRUCTIONS =
  "UpgradeLens answers npm and PyPI upgrade questions with deterministic, source-cited evidence. Call check_dependency_upgrade before editing when both versions are known; use find_safe_upgrade_target only to discover candidates; use plan_dependency_upgrade for review steps. If current_version is unknown, read the project manifest first; if the target is unknown, call find_safe_upgrade_target then check_dependency_upgrade or plan_dependency_upgrade. Edit dependency files only when action_allowed=true. unknown means required evidence or caller context is insufficient.";

const CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "x-upgradelens-testnet-run",
].join(", ");

const PUBLIC_MCP_ORIGIN_SCHEMES = new Set([
  "http:",
  "https:",
  "cursor:",
  "cursor-file:",
  "tauri:",
  "vscode-file:",
  "vscode-webview:",
]);

/**
 * This MCP endpoint is a public HTTPS API with no ambient browser credentials:
 * anonymous access is read-only, and optional credentials are explicit Bearer
 * headers. Validate that Origin is a real serialized web/app origin, while
 * allowing any host so browser and Electron MCP clients can connect.
 */
export function isValidPublicMcpOrigin(origin: string): boolean {
  if (origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return PUBLIC_MCP_ORIGIN_SCHEMES.has(parsed.protocol) && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function applyMcpCorsHeaders(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  if (!isValidPublicMcpOrigin(origin)) return false;
  c.header("access-control-allow-origin", origin);
  c.header("access-control-allow-methods", "POST, OPTIONS");
  c.header("access-control-allow-headers", CORS_ALLOWED_HEADERS);
  c.header(
    "access-control-expose-headers",
    "mcp-protocol-version, mcp-session-id, x-request-id, x-ratelimit-remaining-day",
  );
  c.header("access-control-max-age", "86400");
  c.header("vary", "Origin");
  return true;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ModernRequestMeta {
  "io.modelcontextprotocol/protocolVersion"?: unknown;
  "io.modelcontextprotocol/clientInfo"?: { name?: unknown; version?: unknown };
  "io.modelcontextprotocol/clientCapabilities"?: unknown;
}

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: number | string | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function completeResult<T extends Record<string, unknown>>(result: T, modern: boolean) {
  return modern ? { resultType: "complete" as const, ...result } : result;
}

function decodeMirroredHeader(value: string): string | null {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    const binary = atob(value.slice(9, -2));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function modernHeaderError(
  msg: JsonRpcRequest,
  message: string,
): { response: ReturnType<typeof rpcError>; status: 400 } {
  return { response: rpcError(msg.id ?? null, -32020, message), status: 400 };
}

function validateModernRequestHeaders(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  msg: JsonRpcRequest,
): { response: ReturnType<typeof rpcError>; status: 400 } | null {
  const meta = msg.params?._meta as ModernRequestMeta | undefined;
  if (meta?.["io.modelcontextprotocol/protocolVersion"] !== MODERN_PROTOCOL) {
    return modernHeaderError(
      msg,
      "Header mismatch: MCP-Protocol-Version must match params._meta protocolVersion.",
    );
  }
  if (
    !meta["io.modelcontextprotocol/clientInfo"] ||
    typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object"
  ) {
    return modernHeaderError(msg, "Missing required per-request client metadata.");
  }
  const methodHeader = c.req.header("mcp-method");
  if (methodHeader !== msg.method) {
    return modernHeaderError(msg, "Header mismatch: Mcp-Method does not match the request body.");
  }
  const nameSource =
    msg.method === "tools/call" || msg.method === "prompts/get"
      ? msg.params?.name
      : msg.method === "resources/read"
        ? msg.params?.uri
        : undefined;
  if (nameSource !== undefined) {
    const nameHeader = c.req.header("mcp-name");
    if (
      typeof nameSource !== "string" ||
      !nameHeader ||
      decodeMirroredHeader(nameHeader) !== nameSource
    ) {
      return modernHeaderError(msg, "Header mismatch: Mcp-Name does not match the request body.");
    }
  }
  return null;
}

function normalizeMcpToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "check_dependency_upgrade": {
      const req: UpgradeCheckRequest = validateCheckRequest(args);
      return req as unknown as Record<string, unknown>;
    }
    case "plan_dependency_upgrade": {
      const req: UpgradeCheckRequest = validateCheckRequest(args);
      return req as unknown as Record<string, unknown>;
    }
    case "find_safe_upgrade_target": {
      const eco = validateEcosystem(args.ecosystem);
      const pkg = validatePackageName(eco, args.package);
      const cur = validateVersion("current_version", args.current_version);
      const maxMajorJump =
        typeof args.max_major_jump === "number" && args.max_major_jump >= 0
          ? Math.floor(args.max_major_jump)
          : undefined;
      return {
        ecosystem: eco,
        package: pkg,
        current_version: cur,
        ...(maxMajorJump !== undefined ? { max_major_jump: maxMajorJump } : {}),
        allow_prerelease: args.allow_prerelease === true,
      };
    }
    default:
      throw new ValidationError("name", `Unknown tool: ${name}`);
  }
}

async function executeMcpTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "check_dependency_upgrade":
      return (await checkUpgrade(env, args as unknown as UpgradeCheckRequest)) as unknown as Record<string, unknown>;
    case "plan_dependency_upgrade":
      return (await planUpgrade(env, args as unknown as UpgradeCheckRequest)) as unknown as Record<string, unknown>;
    case "find_safe_upgrade_target":
      return (await findTarget(
        env,
        args.ecosystem as "npm" | "pypi",
        args.package as string,
        args.current_version as string,
        {
          maxMajorJump: typeof args.max_major_jump === "number" ? args.max_major_jump : undefined,
          allowPrerelease: args.allow_prerelease === true,
        },
      )) as unknown as Record<string, unknown>;
    default:
      throw new ValidationError("name", `Unknown tool: ${name}`);
  }
}

async function handleMessage(
  env: Env,
  msg: JsonRpcRequest,
  setTool: (t: string) => void,
  modern: boolean,
  caller: AppVariables["caller"],
  requestId: string,
  forcePayment: boolean,
  businessEligible: boolean,
): Promise<unknown | null> {
  const id = msg.id ?? null;
  // Notifications get no response.
  if (msg.id === undefined && msg.method?.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string) ?? LATEST_LEGACY_PROTOCOL;
      const protocolVersion = LEGACY_PROTOCOLS.has(requested)
        ? requested
        : LATEST_LEGACY_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "upgradelens",
          title: "UpgradeLens — dependency upgrade intelligence",
          version: CONTRACT_VERSION,
        },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "server/discover":
      return rpcResult(
        id,
        completeResult(
          {
            supportedVersions: [...MCP_SUPPORTED_PROTOCOLS],
            capabilities: { tools: { listChanged: false } },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "upgradelens",
                version: CONTRACT_VERSION,
              },
            },
            instructions: MCP_INSTRUCTIONS,
            ttlMs: 3_600_000,
            cacheScope: "public",
          },
          modern,
        ),
      );
    case "ping":
      return rpcResult(id, completeResult({}, modern));
    case "tools/list":
      return rpcResult(
        id,
        completeResult(
          { tools: MCP_TOOLS, ...(modern ? { ttlMs: 3_600_000, cacheScope: "public" } : {}) },
          modern,
        ),
      );
    case "tools/call": {
      const name = (msg.params?.name as string) ?? "";
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      setTool(name);
      if (!MCP_BUSINESS_TOOL_NAMES.has(name)) {
        const structured = machineError("invalid_input", `Unknown tool: ${name}`, false, { field: "name" });
        return rpcResult(id, completeResult({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true }, modern));
      }
      // The global middleware applies the cheap edge/minute fuse to every MCP
      // request. Known business calls additionally consume one daily analysis
      // unit here, after the tool name is known, so handshakes and probes do
      // not exhaust the analysis budget.
      const daily = await checkRateLimit(env, caller, { daily: true, skipEdge: true });
      if (!daily.allowed) {
        const structured = machineError("rate_limited", "The request rate is temporarily limited. Retry after the indicated delay.", true, {
          retry_after_s: daily.retry_after_s,
        });
        return rpcResult(id, completeResult({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true }, modern));
      }
      let outcome;
      try {
        // Normalize before hashing so semantically identical requests have the
        // same idempotency fingerprint (and unrecognized fields never become
        // part of a paid request's identity).
        const normalizedArgs = normalizeMcpToolArgs(name, args);
        outcome = await executeAnalysis({
          env,
          caller,
          requestId,
          operation: name as "check_dependency_upgrade" | "find_safe_upgrade_target" | "plan_dependency_upgrade",
          args: normalizedArgs,
          units: 1,
          resource: mcpToolResourceUrl(env.PUBLIC_BASE_URL, name),
          paymentPayload:
            (msg.params?._meta as Record<string, unknown> | undefined)?.["x402/payment"] as never ?? null,
          businessEligible,
          forcePayment,
          execute: () => {
            // Count an invocation only once validation has passed and the
            // business handler is actually entered.
            setTool(name);
            return executeMcpTool(env, name, normalizedArgs);
          },
        });
      } catch (error) {
        console.error("mcp_tool_execution_failed", { tool: name, error_type: error instanceof Error ? error.name : "unknown", error_message: error instanceof Error ? error.message : String(error) });
        const structured = error instanceof ValidationError
          ? machineError(error.field === "ecosystem" ? "unsupported_ecosystem" : "invalid_input", error.message, false, { field: error.field })
          : error instanceof MachineError
            ? error.toJSON()
            : machineError("internal_error", "Internal analysis error. The service returned no fabricated data.", true);
        return rpcResult(id, completeResult({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true }, modern));
      }
      if (outcome.kind === "error") {
        return rpcResult(id, completeResult({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], structuredContent: outcome.body, isError: true }, modern));
      }
      if (outcome.kind === "payment_required") {
        return rpcResult(id, completeResult({ content: [{ type: "text", text: JSON.stringify(outcome.paymentRequired) }], structuredContent: outcome.paymentRequired, isError: true }, modern));
      }
      const structured = outcome.result;
      return rpcResult(
        id,
        completeResult(
          {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: false,
            ...(outcome.paymentResponse ? { _meta: { "x402/payment-response": outcome.paymentResponse } } : {}),
          },
          modern,
        ),
      );
    }
    case "resources/list":
      return rpcResult(id, completeResult({ resources: [] }, modern));
    case "prompts/list":
      return rpcResult(id, completeResult({ prompts: [] }, modern));
    default:
      if (msg.id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  envOverride: Partial<Pick<Env, "PAYMENT_MODE">> = {},
): Promise<Response> {
  const runtimeEnv = Object.keys(envOverride).length > 0 ? { ...c.env, ...envOverride } : c.env;
  c.set("mcpMethod", `http:${c.req.method.toLowerCase()}`);
  if (!applyMcpCorsHeaders(c)) {
    c.set("mcpErrorKind", "origin_rejected");
    c.set("mcpRpcErrorCode", -32600);
    return c.json(rpcError(null, -32600, "Origin is not a valid public client origin."), 403);
  }
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, { Allow: "POST, OPTIONS" });
  }
  if (c.req.method !== "POST") {
    // Stateless server: no server-initiated streams, no sessions to delete.
    return c.body(null, 405, { Allow: "POST, OPTIONS" });
  }
  const protocolHeader = c.req.header("mcp-protocol-version");
  if (protocolHeader) c.set("mcpProtocolVersion", protocolHeader);

  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) {
    c.set("mcpErrorKind", parsed.status === 413 ? "payload_too_large" : "parse_error");
    c.set("mcpRpcErrorCode", parsed.status === 413 ? -32600 : -32700);
    return c.json(rpcError(null, parsed.status === 413 ? -32600 : -32700, parsed.message), parsed.status);
  }
  const payload = parsed.data;
  if (Array.isArray(payload)) {
    c.set("mcpErrorKind", "batch_not_supported");
    c.set("mcpRpcErrorCode", -32600);
    return c.json(rpcError(null, -32600, "JSON-RPC batches are not accepted by Streamable HTTP."), 400);
  }

  const setTool = (t: string) => {
    c.set("mcpTool", t);
    // This marks a known business-tool request. Semantic success is tracked
    // separately from the returned `isError` flag.
    c.set("mcpToolInvoked", MCP_BUSINESS_TOOL_NAMES.has(t));
  };
  const msg = payload as JsonRpcRequest;
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    c.set("mcpErrorKind", "invalid_request");
    c.set("mcpRpcErrorCode", -32600);
    return c.json(rpcError(null, -32600, "Invalid JSON-RPC message."), 400);
  }
  c.set("mcpMethod", msg.method);
  if (protocolHeader && !SUPPORTED_PROTOCOLS.includes(protocolHeader)) {
    c.set("mcpErrorKind", "unsupported_protocol_version");
    c.set("mcpRpcErrorCode", -32022);
    return c.json(
      rpcError(msg.id ?? null, -32022, "Unsupported protocol version", {
        supported: [...MCP_SUPPORTED_PROTOCOLS],
        requested: protocolHeader,
      }),
      400,
    );
  }
  const modern = protocolHeader === MODERN_PROTOCOL;
  if (modern) {
    const validation = validateModernRequestHeaders(c, msg);
    if (validation) {
      c.set("mcpErrorKind", "header_mismatch");
      c.set("mcpRpcErrorCode", -32020);
      return c.json(validation.response, validation.status);
    }
    const meta = msg.params?._meta as ModernRequestMeta;
    const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
    if (typeof clientInfo?.name === "string") c.set("mcpClientName", clientInfo.name);
    if (typeof clientInfo?.version === "string") c.set("mcpClientVersion", clientInfo.version);
  }
  if (msg.method === "initialize") {
    if (typeof msg.params?.protocolVersion === "string") {
      c.set("mcpProtocolVersion", msg.params.protocolVersion);
    }
    const clientInfo = msg.params?.clientInfo as
      | { name?: unknown; version?: unknown }
      | undefined;
    if (typeof clientInfo?.name === "string") c.set("mcpClientName", clientInfo.name);
    if (typeof clientInfo?.version === "string") c.set("mcpClientVersion", clientInfo.version);
  }
  if (msg.method === "tools/call") {
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    c.set("mcpTool", name);
    const knownTool = MCP_BUSINESS_TOOL_NAMES.has(name);
    c.set("mcpToolInvoked", false);
  }
  const forcePayment = c.req.header("x-upgradelens-payment-probe") === "true";
  const requestedTool = msg.method === "tools/call" && typeof msg.params?.name === "string"
    ? msg.params.name
    : undefined;
  const businessEligible =
    new URL(c.req.url).pathname !== "/mcp-testnet" &&
    classifyMcpSource(
      c.get("caller").internal,
      c.get("caller").authState,
      c.req.header("user-agent"),
      requestedTool,
    ).trafficClass === "external";
  const response = await handleMessage(
    runtimeEnv,
    msg,
    setTool,
    modern,
    c.get("caller"),
    c.get("requestId"),
    forcePayment,
    businessEligible,
  );
  if (response === null) return c.body(null, 202);
  const rpc = response as {
    result?: { isError?: boolean; structuredContent?: unknown };
    error?: { code?: number };
  };
  if (typeof rpc.error?.code === "number") {
    c.set("mcpRpcErrorCode", rpc.error.code);
    c.set("mcpErrorKind", rpc.error.code === -32601 ? "method_not_found" : "rpc_error");
  }
  if (rpc.result?.isError !== undefined) {
    c.set("mcpIsError", rpc.result.isError === true);
    const structured = rpc.result.structuredContent as Record<string, unknown> | undefined;
    if (structured) {
      if (rpc.result.isError === true) {
        const errorCode = String((structured.error as Record<string, unknown> | undefined)?.code);
        const errorText = typeof structured.error === "string"
          ? structured.error
          : typeof (structured.error as Record<string, unknown> | undefined)?.message === "string"
            ? String((structured.error as Record<string, unknown>).message)
            : "";
        c.set(
          "mcpErrorKind",
          errorText.startsWith("Unknown tool:")
            ? "unknown_tool"
            : errorCode === "rate_limited"
              ? "rate_limited"
              : ["invalid_input", "unsupported_ecosystem"].includes(errorCode)
              ? "validation_error"
              : "service_error",
        );
      }
      c.set("meta", {
        ecosystem: typeof structured.ecosystem === "string" ? structured.ecosystem : undefined,
        package: typeof structured.package === "string" ? structured.package : undefined,
      });
      c.set("cacheHit", structured.cache_hit === true);
      c.set("unknownResult", structured.decision === "unknown");
    }
  }
  const status = modern && rpc.error?.code === -32601 ? 404 : 200;
  return c.json(response as object, status);
}
