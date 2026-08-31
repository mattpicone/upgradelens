import type { Env } from "./types";

export const CONTRACT_VERSION = "0.3.0";
export const ANALYSIS_UNIT_PRICE_USD = 0.01;
export const ANALYSIS_UNIT_PRICE_MICROS = 10_000;
export const ANALYSIS_UNIT_ATOMIC_USDC = "10000";
export const DEFAULT_KNOWN_UNIT_COST_MICROS = 1_000;
export const MINIMUM_GROSS_MARGIN = 0.75;
export const MAX_KNOWN_UNIT_COST_MICROS = Math.floor(
  ANALYSIS_UNIT_PRICE_MICROS * (1 - MINIMUM_GROSS_MARGIN),
);
export const TRIAL_WINDOW_DAYS = 30;
export const BASE_MAINNET = "eip155:8453" as const;
export const BASE_SEPOLIA = "eip155:84532" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type OperationName =
  | "check_dependency_upgrade"
  | "find_safe_upgrade_target"
  | "plan_dependency_upgrade";

export type PaymentMode = "validation" | "testnet" | "mainnet" | "paused";

export const CHECK_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ecosystem", "package", "current_version", "target_version"],
  properties: {
    ecosystem: {
      type: "string",
      enum: ["npm", "pypi"],
      description: "Package ecosystem. Only npm and pypi are supported.",
    },
    package: { type: "string", maxLength: 214, description: "Exact registry package name." },
    current_version: { type: "string", maxLength: 64, description: "Exact installed version." },
    target_version: { type: "string", maxLength: 64, description: "Exact candidate version." },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: { node: { type: "string" }, python: { type: "string" } },
    },
  },
} as const;

export const TARGET_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ecosystem", "package", "current_version"],
  properties: {
    ecosystem: {
      type: "string",
      enum: ["npm", "pypi"],
      description: "Package ecosystem. Only npm and pypi are supported.",
    },
    package: { type: "string", maxLength: 214, description: "Exact registry package name." },
    current_version: { type: "string", maxLength: 64, description: "Exact installed version." },
    max_major_jump: {
      type: "integer",
      minimum: 0,
      description: "Optional major-version jump cap. 0 = stay in the same major.",
    },
    allow_prerelease: { type: "boolean" },
  },
} as const;

const BILLING_SCHEMA = {
  type: "object",
  required: ["mode", "units", "price_usd", "trial_remaining", "network", "payment_status"],
  properties: {
    mode: { type: "string", enum: ["validation", "testnet", "mainnet", "paused"] },
    units: { type: "integer", minimum: 1 },
    price_usd: { type: "number" },
    trial_remaining: { type: ["integer", "null"] },
    network: { type: ["string", "null"] },
    payment_status: { type: "string" },
  },
} as const;

const COMMON_RESULT_PROPERTIES = {
  next_action: { type: "string" },
  recommended_target: { type: ["string", "null"] },
  billing: BILLING_SCHEMA,
  ecosystem: { type: "string", enum: ["npm", "pypi"] },
  package: { type: "string" },
  current_version: { type: "string" },
  evidence: { type: "array", items: { type: "object" } },
  coverage: { type: "object" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  freshness: { type: "string" },
  analysis_version: { type: "string" },
} as const;

export const CHECK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: [
    "next_action", "billing", "decision", "action_allowed", "risk_score", "ecosystem",
    "package", "current_version", "target_version", "evidence", "coverage", "confidence",
    "freshness", "analysis_version",
  ],
  properties: {
    ...COMMON_RESULT_PROPERTIES,
    decision: { type: "string", enum: ["proceed", "review_required", "block", "unknown"] },
    action_allowed: { type: "boolean" },
    risk_score: { type: "integer", minimum: 0, maximum: 100 },
    target_version: { type: "string" },
    latest_stable: { type: ["string", "null"] },
    repository_url: { type: ["string", "null"] },
    version_facts: { type: "object" },
    security_delta: { type: "object" },
    compatibility: { type: "object" },
    breaking_changes: { type: "array", items: { type: "object" } },
    reasons: { type: "array", items: { type: "string" } },
    claim_evidence: { type: "array", items: { type: "object" } },
    cache_hit: { type: "boolean" },
  },
} as const;

export const TARGET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: [
    "next_action", "recommended_target", "billing", "ecosystem", "package", "current_version",
    "candidates", "coverage", "confidence", "freshness", "analysis_version",
  ],
  properties: {
    ...COMMON_RESULT_PROPERTIES,
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
          score: { type: "number", description: "Ranking score, not a safety verdict." },
          fixes_advisories: { type: "array", items: { type: "string" } },
          introduces_advisories: { type: "array", items: { type: "string" } },
          semver_jump: { type: "string" },
          published_at: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export const PLAN_OUTPUT_SCHEMA = {
  ...CHECK_OUTPUT_SCHEMA,
  required: [...CHECK_OUTPUT_SCHEMA.required, "migration_actions", "changelog_urls"],
  properties: {
    ...CHECK_OUTPUT_SCHEMA.properties,
    migration_actions: { type: "array", items: { type: "object" } },
    changelog_urls: { type: "array", items: { type: "string" } },
  },
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const OPERATION_CATALOG = [
  {
    name: "check_dependency_upgrade",
    restPath: "/v1/upgrade/check",
    operationId: "checkDependencyUpgrade",
    title: "Assess a known dependency upgrade target (go/no-go)",
    description:
      "Use when a coding agent needs a cited go/no-go risk decision without steps before changing an existing npm or PyPI dependency between two exact versions. Returns action_allowed, vulnerability delta, compatibility, EOL, and breaking-change evidence. Use plan_dependency_upgrade instead for ordered migration work. Do not use to choose a target, install a new package, search general docs, or analyze another ecosystem. Read-only and safe to retry.",
    inputSchema: CHECK_INPUT_SCHEMA,
    outputSchema: CHECK_OUTPUT_SCHEMA,
    example: { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0", runtime: { node: "20.11.0" } },
    outputExample: { next_action: "review_migration_plan", recommended_target: "5.1.0", decision: "review_required", action_allowed: false },
    tags: ["dependency", "upgrade", "security", "npm", "pypi"],
  },
  {
    name: "find_safe_upgrade_target",
    restPath: "/v1/upgrade/target",
    operationId: "findUpgradeCandidates",
    title: "Rank upgrade candidates (not a safety verdict; full check required)",
    description:
      "Use only when an existing npm or PyPI dependency has an exact current version but no chosen target. Ranks candidates; candidates are not declared safe and require check_dependency_upgrade or plan_dependency_upgrade. Do not use when a target is stated, for a new install, or as authorization to edit files. Read-only and safe to retry.",
    inputSchema: TARGET_INPUT_SCHEMA,
    outputSchema: TARGET_OUTPUT_SCHEMA,
    example: { ecosystem: "npm", package: "express", current_version: "4.18.2", max_major_jump: 0 },
    outputExample: { next_action: "check_recommended_target", recommended_target: "4.21.2", candidates: [{ version: "4.21.2", requires_full_check: true }] },
    tags: ["dependency", "upgrade", "versions", "npm", "pypi"],
  },
  {
    name: "plan_dependency_upgrade",
    restPath: "/v1/upgrade/plan",
    operationId: "planDependencyUpgrade",
    title: "Plan a known dependency upgrade (migration/review checklist)",
    description:
      "Use when a coding agent needs a migration checklist, refactor actions, ordered review actions, changelog links, or test steps for exact current and target npm/PyPI versions. Use check_dependency_upgrade instead for a go/no-go without steps. Do not use to choose a target, install a package, or provide a general tutorial. Read-only and safe to retry.",
    inputSchema: CHECK_INPUT_SCHEMA,
    outputSchema: PLAN_OUTPUT_SCHEMA,
    example: { ecosystem: "pypi", package: "django", current_version: "4.2.11", target_version: "5.1.1", runtime: { python: "3.12" } },
    outputExample: { next_action: "complete_migration_actions", recommended_target: "5.1.1", migration_actions: [{ order: 1, action: "Review cited breaking changes." }] },
    tags: ["dependency", "migration", "upgrade", "npm", "pypi"],
  },
] as const;

export const MCP_TOOLS = OPERATION_CATALOG.map((operation) => ({
  name: operation.name,
  title: operation.title,
  description: operation.description,
  inputSchema: operation.inputSchema,
  outputSchema: operation.outputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
}));

export const MCP_BUSINESS_TOOL_NAMES = new Set<string>(
  OPERATION_CATALOG.map((operation) => operation.name),
);

export function operationByName(name: string) {
  return OPERATION_CATALOG.find((operation) => operation.name === name);
}

export function paymentMode(env: Env): PaymentMode {
  if (env.PAYMENT_MODE !== undefined) {
    return env.PAYMENT_MODE === "validation" || env.PAYMENT_MODE === "testnet" ||
      env.PAYMENT_MODE === "mainnet" || env.PAYMENT_MODE === "paused"
      ? env.PAYMENT_MODE
      : "paused";
  }
  return env.PAYMENTS_ENABLED === "true" ? "testnet" : "validation";
}

export function networkForMode(mode: PaymentMode): typeof BASE_MAINNET | typeof BASE_SEPOLIA | null {
  if (mode === "mainnet") return BASE_MAINNET;
  if (mode === "testnet") return BASE_SEPOLIA;
  return null;
}

export function knownUnitCostMicros(env: Env): number | null {
  const raw = env.KNOWN_UNIT_COST_MICROS ?? String(DEFAULT_KNOWN_UNIT_COST_MICROS);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function pricingDocument(env: Env) {
  const mode = paymentMode(env);
  const knownCostMicros = knownUnitCostMicros(env);
  const recipientConfigured = Boolean(env.X402_PAY_TO && /^0x[0-9a-fA-F]{40}$/.test(env.X402_PAY_TO));
  return {
    service: "UpgradeLens",
    version: CONTRACT_VERSION,
    updated: "2026-08-30",
    mode,
    account_required: false,
    api_key_required: false,
    free_entitlement: { units: 1, rolling_days: TRIAL_WINDOW_DAYS, shared_across: ["mcp", "rest"] },
    unit: { name: "analysis", price_usd: ANALYSIS_UNIT_PRICE_USD, atomic_usdc: ANALYSIS_UNIT_ATOMIC_USDC },
    economics: {
      known_unit_cost_micros: knownCostMicros,
      minimum_gross_margin: MINIMUM_GROSS_MARGIN,
      maximum_safe_unit_cost_micros: MAX_KNOWN_UNIT_COST_MICROS,
      margin_gate_ready: knownCostMicros !== null && knownCostMicros <= MAX_KNOWN_UNIT_COST_MICROS,
    },
    batch: { price_per_pair_usd: ANALYSIS_UNIT_PRICE_USD, free_unit_allowed_only_when_pairs: 1 },
    payment: {
      protocol: "x402",
      version: 2,
      asset: "USDC",
      asset_address:
        mode === "mainnet"
          ? BASE_USDC
          : mode === "testnet"
            ? BASE_SEPOLIA_USDC
            : null,
      network: networkForMode(mode),
      recipient_configured: recipientConfigured,
      payment_identifier_required: true,
    },
    operations: OPERATION_CATALOG.map(({ name, restPath }) => ({ name, rest_path: restPath, units: 1 })),
  };
}

export function registryMetadata(env: Env) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.mattpicone/upgradelens",
    title: "UpgradeLens",
    description:
      "Read-only npm/PyPI dependency upgrade decisions, target ranking, and migration plans with current source citations, one free analysis, and autonomous x402 USDC payment.",
    version: CONTRACT_VERSION,
    websiteUrl: env.PUBLIC_BASE_URL,
    repository: { url: "https://github.com/mattpicone/upgradelens", source: "github" },
    remotes: [{ type: "streamable-http", url: `${env.PUBLIC_BASE_URL}/mcp` }],
    _meta: {
      publisher: "Matt Picone",
      ecosystems: ["npm", "pypi"],
      behavior: "read-only",
      source_citations: true,
      pricing_url: `${env.PUBLIC_BASE_URL}/pricing.json`,
      x402: true,
      operations: OPERATION_CATALOG.map((operation) => operation.name),
    },
  };
}

const ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        details: { type: "object" },
      },
    },
  },
} as const;

export function openApiDocument(env: Env) {
  const paths: Record<string, unknown> = {};
  for (const operation of OPERATION_CATALOG) {
    paths[operation.restPath] = {
      post: {
        operationId: operation.operationId,
        summary: operation.description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: operation.inputSchema, example: operation.example } },
        },
        responses: {
          "200": { description: "Completed analysis", content: { "application/json": { schema: operation.outputSchema } } },
          "400": { description: "Invalid input", content: { "application/json": { schema: ERROR_SCHEMA } } },
          "402": { description: "x402 payment required", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } },
          "409": { description: "Payment identifier conflict or replay", content: { "application/json": { schema: ERROR_SCHEMA } } },
          "429": { description: "Rate limited", content: { "application/json": { schema: ERROR_SCHEMA } } },
          "503": { description: "Payment or evidence service unavailable", content: { "application/json": { schema: ERROR_SCHEMA } } },
        },
      },
    };
  }
  paths["/v1/upgrade/batch"] = {
    post: {
      operationId: "batchCheckUpgrades",
      summary: "Check up to three dependency pairs; each pair is one $0.01 analysis unit.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["pairs"],
              properties: { pairs: { type: "array", minItems: 1, maxItems: 3, items: CHECK_INPUT_SCHEMA } },
            },
          },
        },
      },
      responses: {
        "200": { description: "Completed batch" },
        "400": { description: "Invalid input", content: { "application/json": { schema: ERROR_SCHEMA } } },
        "402": { description: "x402 payment required", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } },
        "409": { description: "Payment identifier conflict or replay", content: { "application/json": { schema: ERROR_SCHEMA } } },
        "429": { description: "Rate limited", content: { "application/json": { schema: ERROR_SCHEMA } } },
        "503": { description: "Payment or evidence service unavailable", content: { "application/json": { schema: ERROR_SCHEMA } } },
      },
    },
  };
  paths["/v1/package/{ecosystem}/{name}"] = { get: { operationId: "getPackageSnapshot", summary: "Free, rate-limited package snapshot.", responses: { "200": { description: "Package snapshot" } } } };
  paths["/v1/evidence/{id}"] = { get: { operationId: "getEvidence", summary: "Free evidence provenance lookup.", responses: { "200": { description: "Evidence" } } } };
  paths["/healthz"] = { get: { operationId: "health", summary: "Service health and payment mode.", responses: { "200": { description: "Health" } } } };
  return {
    openapi: "3.1.0",
    info: { title: "UpgradeLens", version: CONTRACT_VERSION, description: registryMetadata(env).description },
    servers: [{ url: env.PUBLIC_BASE_URL }],
    paths,
    components: { schemas: { MachineError: ERROR_SCHEMA } },
  };
}

export function assertContractVersions(files: Record<string, unknown>): string[] {
  const mismatches: string[] = [];
  for (const [name, manifest] of Object.entries(files)) {
    const version = (manifest as { version?: unknown })?.version;
    if (version !== CONTRACT_VERSION) mismatches.push(`${name}: ${String(version)} != ${CONTRACT_VERSION}`);
  }
  return mismatches;
}
