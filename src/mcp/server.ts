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

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = "2025-06-18";

const CHECK_INPUT_SCHEMA = {
  type: "object",
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
    reasons: { type: "array", items: { type: "string" } },
    claim_evidence: { type: "array", items: { type: "object" } },
    evidence: { type: "array", items: { type: "object" } },
    coverage: COVERAGE_SCHEMA,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    freshness: { type: "string" },
    analysis_version: { type: "string" },
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
    title: "Check a dependency upgrade (known target version)",
    description:
      "Use when you are about to change a software package from a known current version to a known target version. Returns proceed | review_required | block | unknown, action_allowed, explicit per-source coverage, and source-cited security, compatibility, EOL and breaking-change evidence. Only edit dependency files when action_allowed is true. Supports npm and PyPI. Do not use merely to install a package, search documentation, or when the target is unknown (use find_safe_upgrade_target).",
    inputSchema: CHECK_INPUT_SCHEMA,
    outputSchema: CHECK_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "find_safe_upgrade_target",
    title: "Find a safe upgrade target (target version unknown)",
    description:
      "Use when a dependency should be upgraded but the target is unknown, and only to discover candidate versions. This is ranking, not authorization: every candidate has requires_full_check=true and must be passed to check_dependency_upgrade before editing dependency files. Returns unknown security status if OSV is unavailable. Supports npm and PyPI. Do not use when the target is already chosen or for newly installed packages.",
    inputSchema: {
      type: "object",
      required: ["ecosystem", "package", "current_version"],
      properties: {
        ecosystem: { type: "string", enum: ["npm", "pypi"] },
        package: { type: "string", description: "Exact registry package name." },
        current_version: { type: "string", description: "Version currently in use." },
        max_major_jump: {
          type: "integer",
          minimum: 0,
          description: "Optional cap on how many major versions a candidate may jump.",
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
            },
          },
        },
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
    title: "Plan a dependency upgrade (migration actions)",
    description:
      "Use after a target version has been selected to obtain source-cited review or migration steps. Returns everything from check_dependency_upgrade plus migration_actions and changelog_urls. It never instructs dependency-file edits when action_allowed is false. Supports npm and PyPI. Do not use for general tutorials or package documentation.",
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
          "UpgradeLens answers npm and PyPI upgrade questions with deterministic, source-cited evidence. Call check_dependency_upgrade before editing when both versions are known; use find_safe_upgrade_target only to discover candidates; use plan_dependency_upgrade for review steps. Edit dependency files only when action_allowed=true. unknown means required evidence or caller context is insufficient.",
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
      return c.json(rpcError(null, -32600, "Origin is not allowed."), 403);
    }
  }
  const protocolHeader = c.req.header("mcp-protocol-version");
  if (protocolHeader && !SUPPORTED_PROTOCOLS.includes(protocolHeader)) {
    return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${protocolHeader}`), 400);
  }

  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) return c.json(rpcError(null, parsed.status === 413 ? -32600 : -32700, parsed.message), parsed.status);
  const payload = parsed.data;
  if (Array.isArray(payload)) return c.json(rpcError(null, -32600, "JSON-RPC batches are not accepted by Streamable HTTP."), 400);

  const setTool = (t: string) => c.set("mcpTool", t);
  const msg = payload as JsonRpcRequest;
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return c.json(rpcError(null, -32600, "Invalid JSON-RPC message."), 400);
  }
  if (msg.method === "tools/call") {
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    c.set("mcpTool", name);
    const daily = await checkRateLimit(c.env, c.get("caller"), { skipEdge: true });
    c.header("x-ratelimit-remaining-day", String(daily.remaining_day));
    if (!daily.allowed) {
      return c.json(
        rpcError(msg.id ?? null, -32000, "Daily analysis quota exceeded; retry later."),
        429,
      );
    }
  }
  const response = await handleMessage(c.env, msg, setTool);
  if (response === null) return c.body(null, 202);
  const rpc = response as { result?: { isError?: boolean; structuredContent?: unknown } };
  if (rpc.result?.isError !== undefined) {
    c.set("mcpIsError", rpc.result.isError === true);
    const structured = rpc.result.structuredContent as Record<string, unknown> | undefined;
    if (structured) {
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
