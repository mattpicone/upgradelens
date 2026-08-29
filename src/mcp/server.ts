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
import { checkRateLimit } from "../telemetry";

export const MCP_SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SUPPORTED_PROTOCOLS: readonly string[] = MCP_SUPPORTED_PROTOCOLS;
const LATEST_PROTOCOL = "2025-06-18";

const CHECK_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ecosystem", "package", "current_version", "target_version"],
  properties: {
    ecosystem: {
      type: "string",
      enum: ["npm", "pypi"],
      description: "Package ecosystem. Only npm and pypi are supported.",
    },
    package: { type: "string", description: "Exact registry package name." },
    current_version: {
      type: "string",
      description: "The version currently used by the repository, e.g. 4.19.2",
    },
    target_version: {
      type: "string",
      description: "The candidate version to upgrade to, e.g. 5.1.0",
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      description:
        "Optional runtime versions for compatibility checking, e.g. {\"node\":\"20.11.0\"} or {\"python\":\"3.12\"}.",
      properties: {
        node: { type: "string" },
        python: { type: "string" },
      },
    },
  },
} as const;

const COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["registry", "osv", "deps_dev", "eol", "breaking_changes"],
  properties: Object.fromEntries(
    ["registry", "osv", "deps_dev", "eol", "breaking_changes"].map((name) => [
      name,
      {
        type: "object",
        required: ["status", "as_of"],
        properties: {
          status: {
            type: "string",
            enum: ["complete", "partial", "unavailable", "not_applicable", "not_covered"],
          },
          as_of: { type: ["string", "null"] },
          detail: { type: "string" },
        },
      },
    ]),
  ),
} as const;

const VERSION_FACTS_SCHEMA = {
  type: "object",
  description: "Publication, yank, deprecation, and version-distance facts the engine already returns.",
  properties: {
    current_published_at: { type: ["string", "null"] },
    target_published_at: { type: ["string", "null"] },
    current_yanked: { type: "boolean" },
    target_yanked: { type: "boolean" },
    package_deprecated: { type: "boolean" },
    target_deprecation_message: { type: ["string", "null"] },
    is_downgrade: { type: "boolean" },
    semver_jump: {
      type: "string",
      enum: ["major", "minor", "patch", "prerelease", "none", "unknown"],
    },
    versions_between: { type: ["integer", "null"] },
  },
} as const;

const SECURITY_DELTA_SCHEMA = {
  type: "object",
  description: "OSV advisory sets affecting current, fixed by target, and still affecting target.",
  properties: {
    advisories_affecting_current: { type: "array", items: { type: "object" } },
    advisories_fixed_by_target: { type: "array", items: { type: "object" } },
    advisories_affecting_target: { type: "array", items: { type: "object" } },
  },
} as const;

const COMPATIBILITY_SCHEMA = {
  type: "object",
  description: "Runtime engines, direct-dependency diff, and license change between the two versions.",
  properties: {
    runtime_supported: { type: ["boolean", "null"] },
    runtime_notes: { type: "array", items: { type: "string" } },
    dependency_changes: {
      type: ["object", "null"],
      properties: {
        added: { type: "array", items: { type: "string" } },
        removed: { type: "array", items: { type: "string" } },
        changed: { type: "array", items: { type: "object" } },
      },
    },
    license_change: { type: ["object", "null"] },
  },
} as const;

const BREAKING_CHANGES_SCHEMA = {
  type: "array",
  description: "Documented breaking-change excerpts extracted from official release notes.",
  items: {
    type: "object",
    properties: {
      summary: { type: "string" },
      severity: { type: "string" },
      confidence: { type: "number" },
      source_url: { type: "string" },
    },
  },
} as const;

const CHECK_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "decision", "action_allowed", "risk_score", "ecosystem", "package", "current_version",
    "target_version", "reasons", "claim_evidence", "evidence", "coverage", "confidence",
    "freshness", "analysis_version",
  ],
  properties: {
    decision: { type: "string", enum: ["proceed", "review_required", "block", "unknown"] },
    action_allowed: { type: "boolean" },
    risk_score: { type: "integer", minimum: 0, maximum: 100 },
    ecosystem: { type: "string", enum: ["npm", "pypi"] },
    package: { type: "string" },
    current_version: { type: "string" },
    target_version: { type: "string" },
    latest_stable: { type: ["string", "null"] },
    repository_url: { type: ["string", "null"] },
    version_facts: VERSION_FACTS_SCHEMA,
    security_delta: SECURITY_DELTA_SCHEMA,
    compatibility: COMPATIBILITY_SCHEMA,
    breaking_changes: BREAKING_CHANGES_SCHEMA,
    reasons: { type: "array", items: { type: "string" } },
    claim_evidence: { type: "array", items: { type: "object" } },
    evidence: { type: "array", items: { type: "object" } },
    coverage: COVERAGE_SCHEMA,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    freshness: { type: "string" },
    analysis_version: { type: "string" },
    cache_hit: { type: "boolean" },
  },
  additionalProperties: true,
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const MCP_TOOLS = [
  {
    name: "check_dependency_upgrade",
    title: "Assess a known dependency upgrade target (go/no-go)",
    description:
      "Use when asked for a go/no-go risk decision, cited assessment, or whether an existing npm or PyPI dependency can move from one exact installed version to one exact target version before editing. Returns decision/action_allowed plus source-cited vulnerability delta, registry-declared Node/Python compatibility, direct-dependency changes, EOL, and documented breaking-change evidence. Use plan_dependency_upgrade instead when migration, refactor, changelog, or test steps are requested. Do not use to choose a target, install a new package, inspect only one version, answer general documentation questions, or analyze another ecosystem. Read-only and safe to retry; validation or unavailable evidence is returned explicitly.",
    inputSchema: CHECK_INPUT_SCHEMA,
    outputSchema: CHECK_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "find_safe_upgrade_target",
    title: "Rank upgrade candidates (not a safety verdict; full check required)",
    description:
      "Use only when asked which version to evaluate, rank, or recommend and an existing npm or PyPI dependency has an exact current version but no target yet. Ranks candidates using version distance and OSV advisory deltas; candidates are not declared safe. Every candidate requires either check_dependency_upgrade for a decision or plan_dependency_upgrade when migration steps are requested; the plan tool already includes the full check. This tool does not evaluate repository code or caller runtime compatibility. Do not use when a target is stated, for a new installation or simple latest-version lookup, or as authorization to modify files. Read-only and safe to retry; unavailable evidence is returned explicitly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ecosystem", "package", "current_version"],
      properties: {
        ecosystem: {
          type: "string",
          enum: ["npm", "pypi"],
          description: "Package ecosystem. Only npm and pypi are supported.",
        },
        package: { type: "string", description: "Exact registry package name." },
        current_version: { type: "string", description: "Version currently in use." },
        max_major_jump: {
          type: "integer",
          minimum: 0,
          description:
            "Optional cap on how many major versions a candidate may jump. 0 = stay in the same major.",
        },
        allow_prerelease: { type: "boolean", description: "Include prerelease candidates." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ecosystem", "package", "current_version", "candidates", "coverage", "confidence", "freshness", "analysis_version"],
      properties: {
        ecosystem: { type: "string", enum: ["npm", "pypi"] },
        package: { type: "string" },
        current_version: { type: "string" },
        latest_stable: { type: ["string", "null"] },
        candidates: {
          type: "array",
          items: {
            type: "object",
            required: ["version", "decision", "requires_full_check", "rationale"],
            properties: {
              version: { type: "string" },
              decision: { type: "string", enum: ["review_required", "block", "unknown"] },
              requires_full_check: { const: true },
              rationale: { type: "array", items: { type: "string" } },
              score: {
                type: "number",
                description: "Ranking score from version distance and advisory deltas; not a safety verdict.",
              },
              fixes_advisories: { type: "array", items: { type: "string" } },
              introduces_advisories: { type: "array", items: { type: "string" } },
              semver_jump: { type: "string" },
              published_at: { type: ["string", "null"] },
            },
          },
        },
        evidence: { type: "array", items: { type: "object" } },
        coverage: { type: "object" },
        confidence: { type: "number" },
        freshness: { type: "string" },
        analysis_version: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "plan_dependency_upgrade",
    title: "Plan a known dependency upgrade (migration/review checklist)",
    description:
      "Use when asked for a migration checklist, refactor actions, ordered review actions, changelog links, or test steps and both exact current and target versions are known. Returns the complete upgrade check plus source-linked migration_actions and changelog_urls; actions remain gated by action_allowed. Supports npm and PyPI only. Use check_dependency_upgrade instead for a go/no-go risk decision without steps. Do not use to choose a target, install a package, provide general tutorials, or modify files. Read-only and safe to retry; validation or unavailable evidence is returned explicitly.",
    inputSchema: CHECK_INPUT_SCHEMA,
    outputSchema: {
      ...CHECK_OUTPUT_SCHEMA,
      required: [...CHECK_OUTPUT_SCHEMA.required, "migration_actions", "changelog_urls"],
      properties: {
        ...CHECK_OUTPUT_SCHEMA.properties,
        migration_actions: { type: "array", items: { type: "object" } },
        changelog_urls: { type: "array", items: { type: "string" } },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
] as const;

export const MCP_BUSINESS_TOOL_NAMES = new Set<string>(MCP_TOOLS.map((tool) => tool.name));

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: number | string | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: unknown; isError: boolean }> {
  try {
    switch (name) {
      case "check_dependency_upgrade": {
        const req: UpgradeCheckRequest = validateCheckRequest(args);
        return { structured: await checkUpgrade(env, req), isError: false };
      }
      case "plan_dependency_upgrade": {
        const req: UpgradeCheckRequest = validateCheckRequest(args);
        return { structured: await planUpgrade(env, req), isError: false };
      }
      case "find_safe_upgrade_target": {
        const eco = validateEcosystem(args.ecosystem);
        const pkg = validatePackageName(eco, args.package);
        const cur = validateVersion("current_version", args.current_version);
        const maxMajorJump =
          typeof args.max_major_jump === "number" && args.max_major_jump >= 0
            ? Math.floor(args.max_major_jump)
            : undefined;
        const result = await findTarget(env, eco, pkg, cur, {
          maxMajorJump,
          allowPrerelease: args.allow_prerelease === true,
        });
        return { structured: result, isError: false };
      }
      default:
        return {
          structured: { error: `Unknown tool: ${name}` },
          isError: true,
        };
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        structured: { error: e.message, field: e.field },
        isError: true,
      };
    }
    console.error("mcp_tool_execution_failed", {
      tool: name,
      error_type: e instanceof Error ? e.name : "unknown",
    });
    return {
      structured: { error: "Internal analysis error. The service returned no fabricated data." },
      isError: true,
    };
  }
}

async function handleMessage(
  env: Env,
  msg: JsonRpcRequest,
  setTool: (t: string) => void,
): Promise<unknown | null> {
  const id = msg.id ?? null;
  // Notifications get no response.
  if (msg.id === undefined && msg.method?.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string) ?? LATEST_PROTOCOL;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
        ? requested
        : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "upgradelens",
          title: "UpgradeLens — dependency upgrade intelligence",
          version: env.SERVICE_VERSION,
        },
        instructions:
          "UpgradeLens answers npm and PyPI upgrade questions with deterministic, source-cited evidence. Call check_dependency_upgrade before editing when both versions are known; use find_safe_upgrade_target only to discover candidates; use plan_dependency_upgrade for review steps. If current_version is unknown, read the project manifest first; if the target is unknown, call find_safe_upgrade_target then check_dependency_upgrade or plan_dependency_upgrade. Edit dependency files only when action_allowed=true. unknown means required evidence or caller context is insufficient.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = (msg.params?.name as string) ?? "";
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      setTool(name);
      const { structured, isError } = await callTool(env, name, args);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
        isError,
      });
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      if (msg.id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
): Promise<Response> {
  c.set("mcpMethod", `http:${c.req.method.toLowerCase()}`);
  if (c.req.method !== "POST") {
    // Stateless server: no server-initiated streams, no sessions to delete.
    return c.body(null, 405, { Allow: "POST" });
  }
  const origin = c.req.header("origin");
  if (origin) {
    const configured = (c.env.ALLOWED_ORIGINS ?? c.env.PUBLIC_BASE_URL)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!configured.includes(origin)) {
      c.set("mcpErrorKind", "origin_rejected");
      c.set("mcpRpcErrorCode", -32600);
      return c.json(rpcError(null, -32600, "Origin is not allowed."), 403);
    }
  }
  const protocolHeader = c.req.header("mcp-protocol-version");
  if (protocolHeader) c.set("mcpProtocolVersion", protocolHeader);
  if (protocolHeader && !SUPPORTED_PROTOCOLS.includes(protocolHeader)) {
    c.set("mcpErrorKind", "unsupported_protocol_version");
    c.set("mcpRpcErrorCode", -32600);
    return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${protocolHeader}`), 400);
  }

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

  const setTool = (t: string) => c.set("mcpTool", t);
  const msg = payload as JsonRpcRequest;
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    c.set("mcpErrorKind", "invalid_request");
    c.set("mcpRpcErrorCode", -32600);
    return c.json(rpcError(null, -32600, "Invalid JSON-RPC message."), 400);
  }
  c.set("mcpMethod", msg.method);
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
    if (knownTool) {
      const daily = await checkRateLimit(c.env, c.get("caller"), { skipEdge: true });
      c.header("x-ratelimit-remaining-day", String(daily.remaining_day));
      if (!daily.allowed) {
        c.set("mcpErrorKind", "rate_limited");
        c.set("mcpRpcErrorCode", -32000);
        return c.json(
          rpcError(msg.id ?? null, -32000, "Daily analysis quota exceeded; retry later."),
          429,
        );
      }
    }
    c.set("mcpToolInvoked", knownTool);
  }
  const response = await handleMessage(c.env, msg, setTool);
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
        const errorText = typeof structured.error === "string" ? structured.error : "";
        c.set(
          "mcpErrorKind",
          errorText.startsWith("Unknown tool:")
            ? "unknown_tool"
            : "field" in structured
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
  return c.json(response as object);
}
