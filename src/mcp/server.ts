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

export const MCP_TOOLS = [
  {
    name: "check_dependency_upgrade",
    title: "Check a dependency upgrade (known target version)",
    description:
      "Use when you are about to change a software package from a known current version to a known target version and need current, verified compatibility, vulnerability, EOL and breaking-change evidence before editing dependency files (package.json, requirements.txt, pyproject.toml, lockfiles). Returns a deterministic decision (proceed | review_required | block | unknown) with risk score, security delta from OSV, runtime compatibility, dependency changes and source-cited evidence. Supports npm and PyPI. Do not use this tool merely to install a package, to search general package documentation, or when you do not yet know the target version (use find_safe_upgrade_target instead).",
    inputSchema: CHECK_INPUT_SCHEMA,
  },
  {
    name: "find_safe_upgrade_target",
    title: "Find a safe upgrade target (target version unknown)",
    description:
      "Use when a dependency should be upgraded but the target version is not yet known. Returns candidate versions ranked by security fixes, known-advisory status, semver distance and stability, each with rationale and evidence. Supports npm and PyPI. Do not use when the target version has already been chosen — use check_dependency_upgrade instead. Do not use for packages you are newly installing.",
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
  },
  {
    name: "plan_dependency_upgrade",
    title: "Plan a dependency upgrade (migration actions)",
    description:
      "Use after a target version has been selected, when you need concrete, source-cited migration actions and changelog locations to address before or while modifying repository code. Returns everything check_dependency_upgrade returns plus ordered migration_actions[] and changelog_urls[]. Supports npm and PyPI. Do not use for general tutorials or package usage documentation.",
    inputSchema: CHECK_INPUT_SCHEMA,
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
          "UpgradeLens answers dependency upgrade questions for npm and PyPI packages with deterministic, source-cited evidence (deps.dev, OSV, registries, endoflife.date). Call check_dependency_upgrade before editing dependency files when both versions are known; find_safe_upgrade_target when the target version is unknown; plan_dependency_upgrade for migration steps after choosing a target. Results include decision, risk_score, evidence and freshness. 'unknown' means insufficient evidence — never fabricated.",
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
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
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
  if (c.req.method === "GET" || c.req.method === "DELETE") {
    // Stateless server: no server-initiated streams, no sessions to delete.
    return c.body(null, 405, { Allow: "POST" });
  }
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error: body must be JSON."), 400);
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0 || messages.length > 10) {
    return c.json(rpcError(null, -32600, "Invalid request batch."), 400);
  }

  const setTool = (t: string) => c.set("mcpTool", t);
  const responses: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as JsonRpcRequest;
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push(rpcError(null, -32600, "Invalid JSON-RPC message."));
      continue;
    }
    const res = await handleMessage(c.env, msg, setTool);
    if (res !== null) responses.push(res);
  }

  if (responses.length === 0) return c.body(null, 202);
  const body = Array.isArray(payload) && responses.length > 1 ? responses : responses[0];
  return c.json(body as object);
}
