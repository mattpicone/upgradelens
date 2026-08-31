import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  paymentIdentifierResourceServerExtension,
  validatePaymentIdentifierRequirement,
} from "@x402/extensions/payment-identifier";
import {
  ANALYSIS_UNIT_PRICE_MICROS,
  BASE_MAINNET,
  BASE_SEPOLIA,
  BASE_USDC,
  BASE_SEPOLIA_USDC,
  CONTRACT_VERSION,
  DEFAULT_KNOWN_UNIT_COST_MICROS,
  MAX_KNOWN_UNIT_COST_MICROS,
  MCP_BUSINESS_TOOL_NAMES,
  OPERATION_CATALOG,
  networkForMode,
  knownUnitCostMicros,
  mcpToolResourceUrl,
  isMcpPaymentResource,
  operationByName,
  paymentMode,
  type OperationName,
  type PaymentMode,
} from "./contract";
import { MachineError, machineError, type MachineErrorBody } from "./errors";
import type { BillingMetadata, Env } from "./types";
import type { CallerIdentity } from "./telemetry";
import { createCdpFacilitatorClient } from "./cdp-facilitator";

type LogicalOperation = OperationName | "batch_check_upgrades";

interface RolloutAcceptanceEvidence {
  git_sha?: string;
  lockfile_hash?: string;
  suite_hash?: string;
  recipient_hash?: string;
  network?: string;
  acceptance_endpoint?: string;
  free_payment_status?: string;
  tools?: Array<{ tool?: string; transaction?: string }>;
  idempotent_retry?: boolean;
  replay_rejected?: boolean;
  payment_challenges?: Array<{
    tool?: string;
    resource?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    payment_identifier_required?: boolean;
  }>;
  unsuitable_task_rejected?: boolean;
  bazaar_mcp_discovered?: boolean;
  bazaar_mcp_tools?: string[];
  bazaar_rest_discovered?: boolean;
  bazaar_rest_tools?: string[];
  dashboard_revenue_unchanged?: boolean;
}

export interface ExecutionInput<T extends object> {
  env: Env;
  caller: CallerIdentity;
  requestId: string;
  operation: LogicalOperation;
  args: Record<string, unknown>;
  units: number;
  resource: string;
  paymentPayload?: PaymentPayload | null;
  /** Transport classification; false excludes validators/scanners from business metrics. */
  businessEligible?: boolean;
  /** Test-only/in-process adapter; production callers use the configured CDP runtime. */
  paymentRuntime?: PaymentRuntimeAdapter;
  /** Test-only state-machine seam; production callers always evaluate the rolling trial. */
  skipTrial?: boolean;
  /** Internal challenge-only probe; bypasses trial/handler execution. */
  forcePayment?: boolean;
  execute(): Promise<T>;
}

export type ExecutionOutcome<T extends object> =
  | { kind: "success"; result: T & { next_action: string; recommended_target?: string | null; billing: BillingMetadata }; paymentResponse?: SettleResponse }
  | { kind: "payment_required"; paymentRequired: PaymentRequired }
  | { kind: "error"; status: number; body: MachineErrorBody };

export type PaymentServerAdapter = Pick<
  x402ResourceServer,
  | "buildPaymentRequirements"
  | "createPaymentRequiredResponse"
  | "findMatchingRequirements"
  | "validateExtensions"
  | "verifyPayment"
  | "settlePayment"
>;

export interface PaymentRuntimeAdapter {
  server: PaymentServerAdapter;
  mode: "testnet" | "mainnet";
  network: `eip155:${string}`;
}

type PaymentRuntime = PaymentRuntimeAdapter;

const runtimeCache = new Map<string, Promise<PaymentRuntime>>();

function isExternalBusinessInput(input: ExecutionInput<object>): boolean {
  return !input.caller.internal &&
    input.caller.authState !== "invalid_key" &&
    input.businessEligible !== false;
}

function isEvmAddress(value: string | undefined): value is string {
  return Boolean(value && /^0x[0-9a-fA-F]{40}$/.test(value));
}

function isStrongSecret(value: string | undefined): value is string {
  return Boolean(value && new TextEncoder().encode(value).byteLength >= 32);
}

function paymentInfrastructureBlockers(env: Env): string[] {
  return [
    ...(isEvmAddress(env.X402_PAY_TO) ? [] : ["X402_PAY_TO is not a valid configured EVM recipient"]),
    ...(isStrongSecret(env.PAYMENT_RECOVERY_SECRET) ? [] : ["PAYMENT_RECOVERY_SECRET must contain at least 32 bytes"]),
    ...(env.CDP_API_KEY_ID ? [] : ["CDP_API_KEY_ID is not configured"]),
    ...(env.CDP_API_KEY_SECRET ? [] : ["CDP_API_KEY_SECRET is not configured"]),
  ];
}

export function paymentActivation(env: Env): {
  mode: PaymentMode;
  ready: boolean;
  blockers: string[];
} {
  const mode = paymentMode(env);
  if (mode === "validation") return { mode, ready: true, blockers: [] };
  const blockers = [
    ...(isStrongSecret(env.TRIAL_HMAC_SECRET) ? [] : ["TRIAL_HMAC_SECRET must contain at least 32 bytes"]),
  ];
  if (mode === "paused") return { mode, ready: blockers.length === 0, blockers };
  blockers.push(...paymentInfrastructureBlockers(env));
  if (mode === "mainnet") {
    const knownCost = knownUnitCostMicros(env);
    blockers.push(
      ...(env.RELEASE_GIT_SHA ? [] : ["RELEASE_GIT_SHA is not configured"]),
      ...(env.RELEASE_LOCKFILE_HASH ? [] : ["RELEASE_LOCKFILE_HASH is not configured"]),
      ...(env.RELEASE_SUITE_HASH ? [] : ["RELEASE_SUITE_HASH is not configured"]),
      ...(knownCost === null
        ? ["KNOWN_UNIT_COST_MICROS is not a valid non-negative integer"]
        : knownCost > MAX_KNOWN_UNIT_COST_MICROS
          ? ["Known unit costs would reduce gross margin below 75%"]
          : []),
    );
  }
  return { mode, ready: blockers.length === 0, blockers };
}

async function paymentRuntime(env: Env, reconciliation = false): Promise<PaymentRuntime> {
  const activation = paymentActivation(env);
  const infrastructureBlockers = paymentInfrastructureBlockers(env);
  if (
    (activation.mode !== "testnet" && activation.mode !== "mainnet") ||
    (reconciliation ? infrastructureBlockers.length > 0 : !activation.ready)
  ) {
    throw new MachineError(
      503,
      "payment_service_unavailable",
      "Payment mode is not safely configured.",
      true,
      { mode: activation.mode, blockers: reconciliation ? infrastructureBlockers : activation.blockers },
    );
  }
  const paidMode = activation.mode === "testnet" || activation.mode === "mainnet" ? activation.mode : null;
  if (!paidMode) throw new MachineError(503, "payment_service_unavailable", "Payment mode is unavailable.", true);
  const network = networkForMode(paidMode);
  if (!network) throw new MachineError(503, "payment_service_unavailable", "Payment network is unavailable.", true);
  const key = `${paidMode}:${network}:${env.X402_PAY_TO}:${env.CDP_FACILITATOR_URL ?? "cdp"}`;
  let promise = runtimeCache.get(key);
  if (!promise) {
    promise = (async (): Promise<PaymentRuntime> => {
      const facilitator = createCdpFacilitatorClient({
        apiKeyId: env.CDP_API_KEY_ID,
        apiKeySecret: env.CDP_API_KEY_SECRET,
        ...(env.CDP_FACILITATOR_URL ? { baseUrl: env.CDP_FACILITATOR_URL } : {}),
      });
      const server = new x402ResourceServer(facilitator);
      server.register(network, new ExactEvmScheme());
      server.registerExtension(paymentIdentifierResourceServerExtension);
      server.registerExtension(bazaarResourceServerExtension);
      await server.initialize();
      return { server, mode: paidMode, network };
    })();
    runtimeCache.set(key, promise);
    promise.catch(() => runtimeCache.delete(key));
  }
  return promise;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPaymentIdentifier(identifier: string): Promise<string> {
  return sha256(`upgradelens-payment-id-v1:${identifier}`);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function recoveryKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`upgradelens-recovery-v1:${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptRecovery(secret: string, value: unknown): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await recoveryKey(secret),
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `v1.${b64(nonce)}.${b64(new Uint8Array(ciphertext))}`;
}

async function decryptRecovery<T>(secret: string, value: string): Promise<T> {
  const [version, nonce, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !ciphertext) throw new Error("invalid recovery payload");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(nonce) },
    await recoveryKey(secret),
    unb64(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function resultFields(
  operation: LogicalOperation,
  raw: Record<string, unknown>,
  billing: BillingMetadata,
): Record<string, unknown> {
  const target =
    operation === "find_safe_upgrade_target"
      ? ((raw.candidates as Array<{ version?: unknown }> | undefined)?.[0]?.version ?? null)
      : (raw.target_version ?? null);
  let nextAction = "review_result";
  if (operation === "find_safe_upgrade_target") nextAction = target ? "check_recommended_target" : "gather_package_evidence";
  else if (operation === "plan_dependency_upgrade") nextAction = raw.action_allowed === true ? "complete_migration_actions" : "resolve_blockers_before_editing";
  else if (raw.decision === "proceed") nextAction = "apply_upgrade";
  else if (raw.decision === "review_required") nextAction = "review_migration_plan";
  else if (raw.decision === "block") nextAction = "keep_current_version";
  else if (raw.decision === "unknown") nextAction = "gather_missing_evidence";
  const {
    billing: _storedBilling,
    next_action: _storedNextAction,
    recommended_target: _storedTarget,
    action_allowed: _storedActionAllowed,
    ...payload
  } = raw;
  return {
    next_action: nextAction,
    ...(target !== undefined ? { recommended_target: target } : {}),
    action_allowed: operation === "find_safe_upgrade_target" ? false : raw.action_allowed === true,
    billing,
    ...payload,
  };
}

async function saveEvent(
  env: Env,
  paymentIdentifier: string | null,
  businessCallId: string | null,
  kind: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO payment_events
         (ts, payment_identifier, business_call_id, event_kind, details_json)
       VALUES (?,?,?,?,?)`,
    ).bind(
      new Date().toISOString(),
      paymentIdentifier,
      businessCallId,
      kind,
      details ? canonicalJson(details) : null,
    ).run();
  } catch {
    // Funnel events are sanitized observability, not settlement authority.
    // Losing one must never strand an otherwise durable authorization between
    // verified/result-saved/settled transitions.
  }
}

async function reserveTrial(
  env: Env,
  subjectHash: string,
  requestId: string,
): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 864e5).toISOString();
  const stale = new Date(now.getTime() - 2 * 60e3).toISOString();
  await env.DB.prepare(
    `INSERT INTO trial_entitlements
       (subject_hash, consumed_at, reserved_by, reserved_at, updated_at)
     VALUES (?,NULL,?,?,?)
     ON CONFLICT(subject_hash) DO UPDATE SET
       reserved_by=excluded.reserved_by,
       reserved_at=excluded.reserved_at,
       updated_at=excluded.updated_at
     WHERE (trial_entitlements.consumed_at IS NULL OR trial_entitlements.consumed_at < ?)
       AND (trial_entitlements.reserved_by IS NULL OR trial_entitlements.reserved_at < ?
            OR trial_entitlements.reserved_by = excluded.reserved_by)`,
  ).bind(subjectHash, requestId, now.toISOString(), now.toISOString(), cutoff, stale).run();
  const row = await env.DB.prepare(
    `SELECT reserved_by FROM trial_entitlements WHERE subject_hash=?`,
  ).bind(subjectHash).first<{ reserved_by: string | null }>();
  return row?.reserved_by === requestId;
}

async function releaseTrial(env: Env, subjectHash: string, requestId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE trial_entitlements SET reserved_by=NULL, reserved_at=NULL, updated_at=?
     WHERE subject_hash=? AND reserved_by=?`,
  ).bind(new Date().toISOString(), subjectHash, requestId).run();
}

async function saveBusinessResult(
  env: Env,
  input: ExecutionInput<Record<string, unknown>>,
  id: string,
  requestHash: string,
  accessType: string,
  businessEligible: boolean,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO business_calls
       (id, request_id, operation, canonical_request_hash, execution_state, result_json,
        delivery_state, access_type, business_eligible, subject_hash, units, created_at, updated_at)
     VALUES (?,?,?,?,? ,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET execution_state='result_saved', result_json=excluded.result_json,
       updated_at=excluded.updated_at`,
  ).bind(
    id,
    input.requestId,
    input.operation,
    requestHash,
    "result_saved",
    canonicalJson(result),
    "withheld",
    accessType,
    businessEligible ? 1 : 0,
    input.caller.trialSubject ?? input.caller.clientKey,
    input.units,
    now,
    now,
  ).run();
}

async function startBusinessCall(
  env: Env,
  input: ExecutionInput<Record<string, unknown>>,
  id: string,
  requestHash: string,
  accessType: string,
  businessEligible: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO business_calls
       (id, request_id, operation, canonical_request_hash, execution_state,
        result_json, delivery_state, access_type, business_eligible, subject_hash,
        units, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    input.requestId,
    input.operation,
    requestHash,
    "executing",
    null,
    "withheld",
    accessType,
    businessEligible ? 1 : 0,
    input.caller.trialSubject ?? input.caller.clientKey,
    input.units,
    now,
    now,
  ).run();
}

async function markDelivered(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE business_calls SET delivery_state='delivered', execution_state='complete',
       delivered_at=?, updated_at=? WHERE id=?`,
  ).bind(new Date().toISOString(), new Date().toISOString(), id).run();
}

function mcpDiscovery(operation: LogicalOperation): Record<string, unknown> {
  const entry = operationByName(operation);
  if (!entry) return {};
  return declareDiscoveryExtension({
    toolName: entry.name,
    description: entry.description,
    transport: "streamable-http",
    inputSchema: entry.inputSchema,
    example: entry.example,
    output: { example: entry.outputExample, schema: entry.outputSchema },
  });
}

function bazaarDiscovery(input: ExecutionInput<Record<string, unknown>>): Record<string, unknown> {
  if (isMcpPaymentResource(input.resource)) return mcpDiscovery(input.operation);
  const entry = operationByName(input.operation);
  const declaration = declareDiscoveryExtension({
    bodyType: "json",
    input: input.args,
    inputSchema: entry?.inputSchema as Record<string, unknown> | undefined,
    output: entry ? { example: entry.outputExample, schema: entry.outputSchema } : undefined,
  });
  const bazaar = declaration.bazaar as unknown as Record<string, unknown>;
  const info = bazaar.info as Record<string, unknown>;
  const bodyInput = info.input as Record<string, unknown>;
  return {
    bazaar: {
      ...bazaar,
      info: { ...info, input: { ...bodyInput, method: "POST" } },
    },
  };
}

function resourceInfo(input: ExecutionInput<Record<string, unknown>>) {
  const entry = operationByName(input.operation);
  return {
    url: input.resource,
    description: entry?.description ?? "Batch dependency upgrade analysis.",
    mimeType: "application/json",
    serviceName: "UpgradeLens",
    tags: entry?.tags ? [...entry.tags] : ["dependency", "upgrade", "security"],
  };
}

async function paymentChallenge(
  input: ExecutionInput<Record<string, unknown>>,
  runtime: PaymentRuntime,
  error = "Payment required for this analysis.",
  failedPayload?: PaymentPayload,
  recordEvent = true,
): Promise<{ required: PaymentRequired; requirements: PaymentRequirements[]; extensions: Record<string, unknown> }> {
  const amountMicros = ANALYSIS_UNIT_PRICE_MICROS * input.units;
  const builtRequirements = await runtime.server.buildPaymentRequirements({
    scheme: "exact",
    network: runtime.network,
    payTo: input.env.X402_PAY_TO!,
    price: `$${(amountMicros / 1_000_000).toFixed(2)}`,
    maxTimeoutSeconds: 300,
  });
  const expectedAsset = runtime.mode === "mainnet" ? BASE_USDC : BASE_SEPOLIA_USDC;
  // The contract is intentionally narrower than the facilitator's supported
  // asset table: only the configured Base USDC contract is billable.  Do not
  // advertise or accept a fallback token if a facilitator ever returns one.
  const requirements = builtRequirements.filter(
    (candidate) =>
      candidate.network === runtime.network &&
      candidate.asset.toLowerCase() === expectedAsset.toLowerCase() &&
      candidate.payTo.toLowerCase() === input.env.X402_PAY_TO!.toLowerCase() &&
      candidate.amount === String(amountMicros),
  );
  if (requirements.length === 0) {
    throw new MachineError(
      503,
      "payment_service_unavailable",
      "The facilitator did not return the configured Base USDC payment terms.",
      true,
      { network: runtime.network, asset: expectedAsset, amount: String(amountMicros) },
    );
  }
  const extensions = {
    ...bazaarDiscovery(input),
    "payment-identifier": declarePaymentIdentifierExtension(true),
  };
  const required = await runtime.server.createPaymentRequiredResponse(
    requirements,
    resourceInfo(input),
    error,
    extensions,
    { operation: input.operation, arguments: input.args },
    failedPayload,
  );
  if (recordEvent) {
    await saveEvent(input.env, null, null, "challenge", {
      operation: input.operation,
      units: input.units,
      mode: runtime.mode,
    });
  }
  return { required, requirements, extensions };
}

function nestedString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === "string" && current.length > 0) return current;
  }
  return null;
}

async function assertMainnetAttested(env: Env): Promise<void> {
  if (paymentMode(env) !== "mainnet") return;
  const [row, acceptanceRow] = await Promise.all([
    env.DB.prepare(
      `SELECT git_sha, lockfile_hash, suite_hash, testnet_transaction, service_version, price_micros, network, recipient_hash
       FROM rollout_attestations WHERE passed_at IS NOT NULL ORDER BY passed_at DESC LIMIT 1`,
    ).first<{
    git_sha: string;
    lockfile_hash: string;
    suite_hash: string;
    testnet_transaction: string;
    service_version: string;
    price_micros: number;
    network: string;
    recipient_hash: string;
    }>(),
    env.DB.prepare(
      `SELECT state, evidence_json FROM discovery_status WHERE channel='testnet_acceptance'`,
    ).first<{ state: string; evidence_json: string | null }>(),
  ]);
  const recipientHash = await sha256((env.X402_PAY_TO ?? "").toLowerCase());
  let acceptance: RolloutAcceptanceEvidence | null = null;
  try {
    acceptance = acceptanceRow?.evidence_json
      ? JSON.parse(acceptanceRow.evidence_json) as RolloutAcceptanceEvidence
      : null;
  } catch {
    acceptance = null;
  }
  const expectedTools = OPERATION_CATALOG.map((operation) => operation.name).sort();
  const acceptedTools = acceptance?.tools?.map((entry) => entry.tool).sort() ?? [];
  const acceptanceTransactions = acceptance?.tools?.map((entry) => entry.transaction) ?? [];
  const expectedAcceptanceEndpoint = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/mcp-testnet`;
  const expectedNetwork = networkForMode("testnet");
  const expectedAsset = BASE_SEPOLIA_USDC.toLowerCase();
  const expectedAmount = String(ANALYSIS_UNIT_PRICE_MICROS);
  const acceptanceChallenges = acceptance?.payment_challenges ?? [];
  const challengeTools = acceptanceChallenges.map((entry) => entry.tool).sort();
  const challengesValid = acceptanceChallenges.length === expectedTools.length &&
    new Set(challengeTools).size === expectedTools.length &&
    JSON.stringify(challengeTools) === JSON.stringify(expectedTools) &&
    acceptanceChallenges.every((entry) =>
      entry.tool &&
      entry.resource === mcpToolResourceUrl(env.PUBLIC_BASE_URL, entry.tool) &&
      entry.network === expectedNetwork &&
      entry.amount === expectedAmount &&
      entry.asset?.toLowerCase() === expectedAsset &&
      entry.payTo?.toLowerCase() === (env.X402_PAY_TO ?? "").toLowerCase() &&
      entry.payment_identifier_required === true,
    );
  const acceptanceBazaarMcpTools = acceptance?.bazaar_mcp_discovered === true &&
    JSON.stringify([...(acceptance?.bazaar_mcp_tools ?? [])].sort()) === JSON.stringify(expectedTools);
  const acceptanceBazaarRestTools = acceptance?.bazaar_rest_discovered === true &&
    JSON.stringify([...(acceptance?.bazaar_rest_tools ?? [])].sort()) === JSON.stringify(expectedTools);
  const acceptanceValid =
    acceptanceRow?.state === "passed" &&
    acceptance?.git_sha === env.RELEASE_GIT_SHA &&
    acceptance?.lockfile_hash === env.RELEASE_LOCKFILE_HASH &&
    acceptance?.suite_hash === env.RELEASE_SUITE_HASH &&
    acceptance?.recipient_hash === recipientHash &&
    acceptance?.network === networkForMode("testnet") &&
    acceptance?.acceptance_endpoint === expectedAcceptanceEndpoint &&
    acceptance?.free_payment_status === "trial" &&
    acceptance?.idempotent_retry === true &&
    acceptance?.replay_rejected === true &&
    challengesValid &&
    acceptance?.unsuitable_task_rejected === true &&
    acceptanceBazaarMcpTools &&
    acceptanceBazaarRestTools &&
    acceptance?.dashboard_revenue_unchanged === true &&
    JSON.stringify(acceptedTools) === JSON.stringify(expectedTools) &&
    acceptanceTransactions.length === expectedTools.length &&
    new Set(acceptanceTransactions).size === expectedTools.length &&
    acceptanceTransactions.every((transaction) => typeof transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction));
  if (
    !row || row.git_sha !== env.RELEASE_GIT_SHA || row.lockfile_hash !== env.RELEASE_LOCKFILE_HASH ||
    row.suite_hash !== env.RELEASE_SUITE_HASH || row.service_version !== CONTRACT_VERSION ||
    row.price_micros !== ANALYSIS_UNIT_PRICE_MICROS ||
    // The attestation records the controlled Base Sepolia acceptance run;
    // mainnet may open only after that testnet proof matches this build and
    // the production recipient fingerprint.
    row.network !== networkForMode("testnet") || row.recipient_hash !== recipientHash ||
    !acceptanceTransactions.includes(row.testnet_transaction) ||
    !acceptanceValid
  ) {
    throw new MachineError(
      503,
      "payment_service_unavailable",
      "Mainnet is blocked because no matching rollout attestation exists.",
      false,
    );
  }
}

async function runFree<T extends object>(
  input: ExecutionInput<T>,
  mode: PaymentMode,
  status: BillingMetadata["payment_status"],
  consume: boolean,
): Promise<ExecutionOutcome<T>> {
  const requestHash = await sha256(canonicalJson({ operation: input.operation, args: input.args, units: input.units, resource: input.resource }));
  const id = `${status}:${input.requestId}`;
  try {
    const businessEligible = isExternalBusinessInput(input) && mode !== "testnet";
    await startBusinessCall(input.env, input as ExecutionInput<Record<string, unknown>>, id, requestHash, status, businessEligible);
    const raw = await input.execute();
    const billing: BillingMetadata = {
      mode,
      units: input.units,
      price_usd: ANALYSIS_UNIT_PRICE_MICROS * input.units / 1_000_000,
      trial_remaining: mode === "validation" ? null : 0,
      network: networkForMode(mode),
      payment_status: status,
    };
    const result = resultFields(input.operation, raw as Record<string, unknown>, billing) as ExecutionOutcome<T> extends { result: infer R } ? R : never;
    // Every externally delivered result is recorded in the durable business
    // ledger, including validation-mode calls.  The dashboard can therefore
    // distinguish genuine attempts from protocol traffic without relying on
    // legacy request counters.
    await saveBusinessResult(input.env, input as ExecutionInput<Record<string, unknown>>, id, requestHash, status, businessEligible, result);
    if (consume) {
      // The migration trigger consumes the entitlement and marks exactly this
      // reservation's saved result delivered in one SQLite transaction.
      const now = new Date().toISOString();
      const consumption = await input.env.DB.prepare(
        `UPDATE trial_entitlements SET consumed_at=?, reserved_by=NULL, reserved_at=NULL, updated_at=?
         WHERE subject_hash=? AND reserved_by=?`,
      ).bind(now, now, input.caller.trialSubject ?? input.caller.clientKey, input.requestId).run();
      // Production D1 includes rows written by the delivery trigger in
      // meta.changes, so a successful consume reports 1 or 2. Only a zero
      // count means the lease was lost before consumption.
      if (Number(consumption.meta?.changes ?? 0) < 1) {
        await input.env.DB.prepare(
          `UPDATE business_calls SET execution_state='failed', delivery_state='withheld', updated_at=?
           WHERE id=? AND delivery_state='withheld'`,
        ).bind(new Date().toISOString(), id).run().catch(() => {});
        return {
          kind: "error",
          status: 503,
          body: machineError(
            "payment_service_unavailable",
            "The rolling trial reservation expired before delivery; no entitlement was consumed by this request.",
            true,
          ),
        };
      }
    } else {
      await markDelivered(input.env, id);
    }
    return { kind: "success", result };
  } catch (error) {
    await input.env.DB.prepare(
      `UPDATE business_calls SET execution_state='failed', delivery_state='withheld', updated_at=?
       WHERE id=? AND delivery_state='withheld'`,
    ).bind(new Date().toISOString(), id).run().catch(() => {});
    if (consume) await releaseTrial(input.env, input.caller.trialSubject ?? input.caller.clientKey, input.requestId).catch(() => {});
    throw error;
  }
}

async function cachedSettlementOutcome<T extends object>(
  input: ExecutionInput<T>,
  runtime: PaymentRuntime,
  businessCallId: string,
  receiptJson: string | null,
): Promise<ExecutionOutcome<T>> {
  const call = await input.env.DB.prepare(
    `SELECT result_json, delivery_state FROM business_calls WHERE id=?`,
  ).bind(businessCallId).first<{ result_json: string; delivery_state: string }>();
  if (!call?.result_json) {
    return {
      kind: "error",
      status: 409,
      body: machineError(
        "payment_pending",
        "Settlement is recorded but the delivered result is still being reconciled; retry with the same payment identifier.",
        true,
      ),
    };
  }
  const raw = JSON.parse(call.result_json) as T & { billing?: BillingMetadata };
  const billing: BillingMetadata = {
    mode: runtime.mode,
    units: input.units,
    price_usd: ANALYSIS_UNIT_PRICE_MICROS * input.units / 1_000_000,
    trial_remaining: 0,
    network: runtime.network,
    payment_status: "cached_settlement",
  };
  const result = resultFields(input.operation, raw, billing) as ExecutionOutcome<T> extends { result: infer R } ? R : never;
  await markDelivered(input.env, businessCallId);
  return {
    kind: "success",
    result,
    ...(receiptJson ? { paymentResponse: JSON.parse(receiptJson) as SettleResponse } : {}),
  };
}

function settlementTransaction(settlement: SettleResponse): string | null {
  return typeof settlement.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction.trim())
    ? settlement.transaction
    : null;
}

function settlementMatchesRequirements(
  settlement: SettleResponse,
  network: string,
  amount: string,
): boolean {
  return settlement.network === network &&
    (settlement.amount === undefined || settlement.amount === amount);
}

async function duplicateTransactionOwner(
  env: Env,
  transaction: string,
  paymentIdentifier: string,
): Promise<string | null> {
  const duplicate = await env.DB.prepare(
    `SELECT payment_identifier FROM payment_attempts
     WHERE transaction_hash=? AND payment_identifier<>? LIMIT 1`,
  ).bind(transaction, paymentIdentifier).first<{ payment_identifier: string }>();
  return duplicate?.payment_identifier ?? null;
}

async function executePaid<T extends object>(
  input: ExecutionInput<T>,
  runtime: PaymentRuntime,
): Promise<ExecutionOutcome<T>> {
  await assertMainnetAttested(input.env);
  const challenge = await paymentChallenge(input as ExecutionInput<Record<string, unknown>>, runtime);
  const payload = input.paymentPayload;
  if (!payload) return { kind: "payment_required", paymentRequired: challenge.required };

  const identifierValidation = validatePaymentIdentifierRequirement(payload, true);
  const rawPaymentIdentifier = extractPaymentIdentifier(payload);
  if (!identifierValidation.valid || !rawPaymentIdentifier) {
    return {
      kind: "error",
      status: 400,
      body: machineError("payment_invalid", "A valid payment-identifier extension is required.", false, {
        errors: identifierValidation.errors ?? [],
      }),
    };
  }
  // Payment identifiers are client-provided idempotency material. Persist only
  // a domain-separated hash; the raw value remains in memory for this request
  // and inside the encrypted recovery payload when reconciliation is needed.
  const paymentIdentifier = await hashPaymentIdentifier(rawPaymentIdentifier);
  if (payload.x402Version !== 2) {
    return {
      kind: "error",
      status: 402,
      body: machineError("payment_invalid", "Only x402 v2 payment authorizations are accepted.", false, {
        expected_x402_version: 2,
      }),
    };
  }
  if (payload.resource?.url !== input.resource) {
    return {
      kind: "error",
      status: 402,
      body: machineError("payment_invalid", "Payment resource does not match this operation.", false, {
        expected_resource: input.resource,
      }),
    };
  }
  const requirements = runtime.server.findMatchingRequirements(challenge.required.accepts, payload);
  if (!requirements) {
    return {
      kind: "error",
      status: 402,
      body: machineError("payment_invalid", "Payment terms do not match this request.", false, {
        expected_network: runtime.network,
        expected_units: input.units,
      }),
    };
  }
  const extensionsValid = runtime.server.validateExtensions(challenge.required, payload);
  if (!extensionsValid.valid) {
    return { kind: "error", status: 400, body: machineError("payment_invalid", extensionsValid.invalidReason ?? "Payment extensions are invalid.", false) };
  }

  const requestHash = await sha256(canonicalJson({ operation: input.operation, args: input.args, units: input.units, resource: input.resource }));
  const fingerprint = await sha256(canonicalJson({
    operation: input.operation,
    args: input.args,
    units: input.units,
    resource: input.resource,
    network: requirements.network,
    asset: requirements.asset.toLowerCase(),
    amount: requirements.amount,
    recipient: requirements.payTo.toLowerCase(),
  }));
  const proofHash = await sha256(canonicalJson(payload));
  const nonce = nestedString(payload.payload, [["authorization", "nonce"], ["nonce"]]);
  const payer = nestedString(payload.payload, [["authorization", "from"], ["from"], ["payer"]]);
  if (!nonce || !payer) {
    return {
      kind: "error",
      status: 400,
      body: machineError(
        "payment_invalid",
        "An exact EVM authorization must include both payer and nonce replay material.",
        false,
      ),
    };
  }
  const nonceHash = await sha256(nonce);
  const payerHash = await sha256(payer.toLowerCase());
  const businessCallId = `payment:${paymentIdentifier}`;
  const now = new Date().toISOString();
  const eligibleMainnetTerms =
    runtime.mode === "mainnet" &&
    requirements.network === "eip155:8453" &&
    requirements.asset.toLowerCase() === BASE_USDC.toLowerCase() &&
    requirements.amount === String(ANALYSIS_UNIT_PRICE_MICROS * input.units) &&
    requirements.payTo.toLowerCase() === input.env.X402_PAY_TO!.toLowerCase() &&
    isExternalBusinessInput(input);

  const existing = await input.env.DB.prepare(
    `SELECT canonical_fingerprint, settlement_state, receipt_json, updated_at
     FROM payment_attempts WHERE payment_identifier=?`,
  ).bind(paymentIdentifier).first<{ canonical_fingerprint: string; settlement_state: string; receipt_json: string | null; updated_at: string }>();
  if (existing && existing.canonical_fingerprint !== fingerprint) {
    return { kind: "error", status: 409, body: machineError("identifier_conflict", "Payment identifier was already bound to a different request.", false) };
  }
  if (existing?.settlement_state === "settled") {
    return cachedSettlementOutcome(input, runtime, businessCallId, existing.receipt_json);
  }
  if (existing?.settlement_state === "invalid") {
    return {
      kind: "error",
      status: 402,
      body: machineError(
        "payment_invalid",
        "This payment identifier is bound to an authorization that failed verification; use a new identifier after correcting the payment.",
        false,
      ),
    };
  }
  if (existing?.settlement_state === "handler_failed") {
    return {
      kind: "error",
      status: 503,
      body: machineError(
        "payment_service_unavailable",
        "The paid handler failed for this payment identifier; no settlement was attempted. Use a new identifier after correcting the request.",
        false,
      ),
    };
  }
  if (existing?.settlement_state === "failed") {
    return {
      kind: "error",
      status: 503,
      body: machineError(
        "payment_service_unavailable",
        "Settlement failed for this payment identifier; use a new identifier and retry.",
        false,
      ),
    };
  }
  if (existing && ["executing", "settling", "pending"].includes(existing.settlement_state)) {
    return { kind: "error", status: 409, body: machineError("payment_pending", "The original authorization is still being reconciled; retry with the same payment identifier.", true) };
  }
  if (existing?.settlement_state === "created") {
    return {
      kind: "error",
      status: 409,
      body: machineError("payment_pending", "The original authorization is still being verified; retry with the same payment identifier.", true),
    };
  }

  const encryptedRecovery = await encryptRecovery(input.env.PAYMENT_RECOVERY_SECRET!, {
    payload,
    requirements,
    extensions: challenge.extensions,
  });
  const knownFeeMicros = (knownUnitCostMicros(input.env) ?? DEFAULT_KNOWN_UNIT_COST_MICROS) * input.units;
  try {
    await input.env.DB.prepare(
      `INSERT INTO payment_attempts
       (payment_identifier, business_call_id, canonical_fingerprint, request_hash, proof_hash,
       payer_hash, nonce_hash, network, asset, amount_atomic, known_fee_micros, recipient,
        settlement_state, recovery_payload, eligible_mainnet, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      paymentIdentifier,
      businessCallId,
      fingerprint,
      requestHash,
      proofHash,
      payerHash,
      nonceHash,
      requirements.network,
      requirements.asset.toLowerCase(),
      requirements.amount,
      knownFeeMicros,
      requirements.payTo.toLowerCase(),
      "created",
      encryptedRecovery,
      eligibleMainnetTerms ? 1 : 0,
      now,
      now,
    ).run();
  } catch (error) {
    // Two retries can race on the same identifier.  Whichever request owns the
    // durable row is authoritative; the loser reports reconciliation status
    // instead of executing the paid handler a second time.
    const sameIdentifier = await input.env.DB.prepare(
      `SELECT canonical_fingerprint, settlement_state, receipt_json FROM payment_attempts WHERE payment_identifier=?`,
    ).bind(paymentIdentifier).first<{ canonical_fingerprint: string; settlement_state: string; receipt_json: string | null }>();
    if (sameIdentifier) {
      if (sameIdentifier.canonical_fingerprint !== fingerprint) {
        return { kind: "error", status: 409, body: machineError("identifier_conflict", "Payment identifier was already bound to a different request.", false) };
      }
      if (sameIdentifier.settlement_state === "settled") {
        return cachedSettlementOutcome(input, runtime, businessCallId, sameIdentifier.receipt_json);
      }
      if (["executing", "settling", "pending", "created"].includes(sameIdentifier.settlement_state)) {
        return { kind: "error", status: 409, body: machineError("payment_pending", "The original authorization is still being reconciled; retry with the same payment identifier.", true) };
      }
      if (sameIdentifier.settlement_state === "invalid") {
        return { kind: "error", status: 402, body: machineError("payment_invalid", "The original authorization failed verification.", false) };
      }
      if (["handler_failed", "failed"].includes(sameIdentifier.settlement_state)) {
        return { kind: "error", status: 503, body: machineError("payment_service_unavailable", "The original authorization ended in a terminal failure; use a new payment identifier.", false) };
      }
    }
    if (nonceHash) {
      const replay = await input.env.DB.prepare(
        `SELECT payment_identifier FROM payment_attempts WHERE nonce_hash=?`,
      ).bind(nonceHash).first<{ payment_identifier: string }>();
      if (replay && replay.payment_identifier !== paymentIdentifier) {
        return { kind: "error", status: 409, body: machineError("payment_replay", "The EIP-3009 nonce was already used.", false) };
      }
    }
    throw error;
  }

  const verified = await runtime.server.verifyPayment(
    payload,
    requirements,
    challenge.extensions,
    { operation: input.operation, arguments: input.args },
  );
  if (!verified.isValid) {
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='invalid', failure_code=?, recovery_payload=NULL, updated_at=?
       WHERE payment_identifier=?`,
    ).bind(verified.invalidReason ?? "verification_failed", new Date().toISOString(), paymentIdentifier).run();
    await saveEvent(input.env, paymentIdentifier, businessCallId, "verify_failed");
    return { kind: "error", status: 402, body: machineError("payment_invalid", verified.invalidReason ?? "Payment verification failed.", false) };
  }
  const executionClaim = await input.env.DB.prepare(
    `UPDATE payment_attempts SET settlement_state='executing', verified_at=?, updated_at=?
     WHERE payment_identifier=? AND settlement_state='created'`,
  ).bind(new Date().toISOString(), new Date().toISOString(), paymentIdentifier).run();
  if (Number(executionClaim.meta?.changes ?? 0) !== 1) {
    return {
      kind: "error",
      status: 409,
      body: machineError("payment_pending", "The authorization state changed while verification completed; reconciliation owns the result.", true),
    };
  }
  await saveEvent(input.env, paymentIdentifier, businessCallId, "verified");

  await startBusinessCall(
    input.env,
    input as ExecutionInput<Record<string, unknown>>,
    businessCallId,
    requestHash,
    "paid",
    isExternalBusinessInput(input) && runtime.mode === "mainnet",
  );

  let raw: T;
  try {
    raw = await input.execute();
  } catch (error) {
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='handler_failed', failure_code='handler_failed',
       recovery_payload=NULL, updated_at=? WHERE payment_identifier=?`,
    ).bind(new Date().toISOString(), paymentIdentifier).run();
    await input.env.DB.prepare(
      `UPDATE business_calls SET execution_state='failed', delivery_state='withheld', updated_at=?
       WHERE id=? AND delivery_state='withheld'`,
    ).bind(new Date().toISOString(), businessCallId).run().catch(() => {});
    await saveEvent(input.env, paymentIdentifier, businessCallId, "handler_failed");
    throw error;
  }
  const billing: BillingMetadata = {
    mode: runtime.mode,
    units: input.units,
    price_usd: ANALYSIS_UNIT_PRICE_MICROS * input.units / 1_000_000,
    trial_remaining: 0,
    network: runtime.network,
    payment_status: "settled",
  };
  const result = resultFields(input.operation, raw as Record<string, unknown>, billing) as ExecutionOutcome<T> extends { result: infer R } ? R : never;
  await saveBusinessResult(
    input.env,
    input as ExecutionInput<Record<string, unknown>>,
    businessCallId,
    requestHash,
    "paid",
    isExternalBusinessInput(input) && runtime.mode === "mainnet",
    result,
  );
  await input.env.DB.prepare(
    `UPDATE payment_attempts SET settlement_state='settling', result_saved_at=?, updated_at=?
     WHERE payment_identifier=?`,
  ).bind(new Date().toISOString(), new Date().toISOString(), paymentIdentifier).run();

  let settlement: SettleResponse;
  try {
    settlement = await runtime.server.settlePayment(
      payload,
      requirements,
      challenge.extensions,
      { operation: input.operation, arguments: input.args },
    );
  } catch {
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='pending', failure_code='settlement_ambiguous',
       updated_at=? WHERE payment_identifier=?`,
    ).bind(new Date().toISOString(), paymentIdentifier).run();
    await saveEvent(input.env, paymentIdentifier, businessCallId, "settlement_pending");
    return { kind: "error", status: 409, body: machineError("payment_pending", "Settlement outcome is ambiguous. Retry with the same authorization; do not create a new payment.", true) };
  }
  if (!settlement.success) {
    const pending = settlement.errorReason === "settlement_pending";
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state=?, failure_code=?, receipt_json=?,
       recovery_payload=CASE WHEN ?='pending' THEN recovery_payload ELSE NULL END, updated_at=?
       WHERE payment_identifier=?`,
    ).bind(
      pending ? "pending" : "failed",
      settlement.errorReason ?? settlement.errorMessage ?? "settlement_failed",
      pending ? null : canonicalJson(settlement),
      pending ? "pending" : "failed",
      new Date().toISOString(),
      paymentIdentifier,
    ).run();
    await saveEvent(input.env, paymentIdentifier, businessCallId, pending ? "settlement_pending" : "settlement_failed");
    return {
      kind: "error",
      status: pending ? 409 : 503,
      body: machineError(
        pending ? "payment_pending" : "payment_service_unavailable",
        pending ? "Settlement is pending. Retry with the same authorization." : "Payment settlement failed.",
        pending,
      ),
    };
  }

  const transaction = settlementTransaction(settlement);
  if (!transaction || !settlementMatchesRequirements(settlement, requirements.network, requirements.amount)) {
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='pending', failure_code='invalid_settlement_receipt',
       receipt_json=NULL, updated_at=? WHERE payment_identifier=?`,
    ).bind(new Date().toISOString(), paymentIdentifier).run();
    await saveEvent(input.env, paymentIdentifier, businessCallId, "settlement_pending", {
      reason: "invalid_settlement_receipt",
    });
    return {
      kind: "error",
      status: 409,
      body: machineError("payment_pending", "The facilitator returned an incomplete or mismatched settlement receipt; reconciliation will retry the same authorization.", true),
    };
  }
  if (await duplicateTransactionOwner(input.env, transaction, paymentIdentifier)) {
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='failed', failure_code='duplicate_transaction',
       receipt_json=?, recovery_payload=NULL, updated_at=? WHERE payment_identifier=?`,
    ).bind(canonicalJson(settlement), new Date().toISOString(), paymentIdentifier).run();
    await input.env.DB.prepare(
      `UPDATE business_calls SET execution_state='failed', delivery_state='withheld', updated_at=? WHERE id=?`,
    ).bind(new Date().toISOString(), businessCallId).run().catch(() => {});
    await saveEvent(input.env, paymentIdentifier, businessCallId, "settlement_failed", { reason: "duplicate_transaction" });
    return {
      kind: "error",
      status: 409,
      body: machineError("payment_replay", "This settlement transaction is already bound to another payment identifier.", false),
    };
  }

  // A revenue ledger entry must point to a real facilitator receipt. A
  // success response must carry a unique transaction on the requested chain.
  const eligibleMainnet = eligibleMainnetTerms;
  try {
    await input.env.DB.batch([
      input.env.DB.prepare(
        `UPDATE payment_attempts SET settlement_state='settled', receipt_json=?, transaction_hash=?,
         settled_at=?, recovery_payload=NULL, eligible_mainnet=?, updated_at=? WHERE payment_identifier=?`,
      ).bind(
        canonicalJson(settlement),
        transaction,
        new Date().toISOString(),
        eligibleMainnet ? 1 : 0,
        new Date().toISOString(),
        paymentIdentifier,
      ),
      input.env.DB.prepare(
        `INSERT OR IGNORE INTO billing_ledger_v3
         (payment_identifier, transaction_hash, amount_micros, fee_micros, network, asset,
          recipient, eligible_mainnet, refunded_micros, created_at)
         VALUES (?,?,?,?,?,?,?,?,0,?)`,
      ).bind(
        paymentIdentifier,
        transaction,
        ANALYSIS_UNIT_PRICE_MICROS * input.units,
        knownFeeMicros,
        requirements.network,
        requirements.asset.toLowerCase(),
        requirements.payTo.toLowerCase(),
        eligibleMainnet ? 1 : 0,
        new Date().toISOString(),
      ),
      input.env.DB.prepare(
        `UPDATE business_calls SET delivery_state='delivered', execution_state='complete',
         delivered_at=?, updated_at=? WHERE id=?`,
      ).bind(new Date().toISOString(), new Date().toISOString(), businessCallId),
    ]);
  } catch {
    // Another identifier may have committed the same facilitator transaction
    // between the preflight duplicate check and this atomic batch.
    try {
      if (await duplicateTransactionOwner(input.env, transaction, paymentIdentifier)) {
        await input.env.DB.prepare(
          `UPDATE payment_attempts SET settlement_state='failed', failure_code='duplicate_transaction',
           receipt_json=?, recovery_payload=NULL, updated_at=? WHERE payment_identifier=?`,
        ).bind(canonicalJson(settlement), new Date().toISOString(), paymentIdentifier).run();
        await input.env.DB.prepare(
          `UPDATE business_calls SET execution_state='failed', delivery_state='withheld', updated_at=? WHERE id=?`,
        ).bind(new Date().toISOString(), businessCallId).run().catch(() => {});
        return {
          kind: "error",
          status: 409,
          body: machineError("payment_replay", "This settlement transaction is already bound to another payment identifier.", false),
        };
      }
    } catch {
      // The durable pending state below is the safe fallback when D1 itself is
      // temporarily unavailable and duplicate ownership cannot be inspected.
    }
    await input.env.DB.prepare(
      `UPDATE payment_attempts SET settlement_state='pending', failure_code='ledger_write_failed',
       receipt_json=?, updated_at=? WHERE payment_identifier=?`,
    ).bind(canonicalJson(settlement), new Date().toISOString(), paymentIdentifier).run().catch(() => {});
    return { kind: "error", status: 409, body: machineError("payment_pending", "Settlement succeeded but durable delivery accounting is still being reconciled.", true) };
  }
  await saveEvent(input.env, paymentIdentifier, businessCallId, "delivered", {
    eligible_mainnet: eligibleMainnet,
    transaction_hash: await sha256(transaction),
  });
  return { kind: "success", result, paymentResponse: settlement };
}

export async function executeAnalysis<T extends object>(
  input: ExecutionInput<T>,
): Promise<ExecutionOutcome<T>> {
  const mode = paymentMode(input.env);
  if (!input.forcePayment) {
    if (input.caller.internal) return runFree(input, mode, "owner", false);
    if (mode === "validation") return runFree(input, mode, "validation_free", false);
  } else if (mode === "validation") {
    return {
      kind: "error",
      status: 503,
      body: machineError("payment_service_unavailable", "Payment challenge probing is unavailable while the service is in validation mode.", true),
    };
  }

  // Paid-mode prerequisites must not prevent the one bounded evaluation from
  // working.  A configured trial HMAC is sufficient for that free unit; the
  // facilitator/recipient/recovery checks apply only when charging begins.
  if (!input.forcePayment && !input.skipTrial && input.units === 1 && isStrongSecret(input.env.TRIAL_HMAC_SECRET)) {
    try {
      const trial = await reserveTrial(input.env, input.caller.trialSubject ?? input.caller.clientKey, input.requestId);
      if (trial) return runFree(input, mode, "trial", true);
    } catch {
      return {
        kind: "error",
        status: 503,
        body: machineError("payment_service_unavailable", "The rolling trial entitlement store is temporarily unavailable.", true),
      };
    }
  }
  const activation = paymentActivation(input.env);
  if (!activation.ready) {
    return {
      kind: "error",
      status: 503,
      body: machineError("payment_service_unavailable", "The service is not safely configured for its current payment mode.", true, { blockers: activation.blockers }),
    };
  }
  if (mode === "paused") {
    return { kind: "error", status: 503, body: machineError("service_unavailable", "Paid analyses are paused; the rolling free unit has already been used.", true) };
  }
  try {
    const runtime = await (input.paymentRuntime ?? paymentRuntime(input.env));
    if (input.forcePayment) {
      await assertMainnetAttested(input.env);
      const challenge = await paymentChallenge(
        input as ExecutionInput<Record<string, unknown>>,
        runtime,
        "Payment construction probe; no authorization was accepted.",
        undefined,
        false,
      );
      return { kind: "payment_required", paymentRequired: challenge.required };
    }
    return await executePaid(input, runtime);
  } catch (error) {
    if (error instanceof MachineError) return { kind: "error", status: error.status, body: error.toJSON() };
    console.error("payment_gate_failed", { error_type: error instanceof Error ? error.name : "unknown" });
    return { kind: "error", status: 503, body: machineError("payment_service_unavailable", "Payment processing is temporarily unavailable.", true) };
  }
}

export function paymentPayloadFromHeader(header: string | null): PaymentPayload | null {
  if (!header) return null;
  try {
    const decoded = decodePaymentSignatureHeader(header);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid payload shape");
    return decoded;
  } catch {
    throw new MachineError(
      400,
      "payment_invalid",
      "The PAYMENT-SIGNATURE header is malformed.",
      false,
    );
  }
}

export function paymentRequiredHeader(required: PaymentRequired): string {
  return encodePaymentRequiredHeader(required);
}

export function paymentResponseHeader(response: SettleResponse): string {
  return encodePaymentResponseHeader(response);
}

export async function reconcilePendingPayments(
  env: Env,
  limit = 8,
  runtimeOverride?: PaymentRuntimeAdapter,
): Promise<number> {
  const mode = paymentMode(env);
  // Pausing new paid calls must not strand authorizations that already reached
  // the durable pending state. Reconciliation below selects the facilitator
  // network from each immutable payment row, so it is safe to continue while
  // the public gate is paused.
  if (mode !== "testnet" && mode !== "mainnet" && mode !== "paused") return 0;
  if (paymentInfrastructureBlockers(env).length > 0 || !env.PAYMENT_RECOVERY_SECRET) return 0;
  // A worker crash can leave a verified attempt in `executing` before its
  // handler result is durable. Never settle an authorization without that
  // result; expire the orphan instead so a buyer can retry with a new
  // identifier rather than leaving the state machine wedged forever.
  const executionCutoff = new Date(Date.now() - 10 * 60e3).toISOString();
  await env.DB.prepare(
    `UPDATE payment_attempts SET settlement_state='failed',
       failure_code='authorization_creation_timeout', recovery_payload=NULL, updated_at=?
     WHERE settlement_state='created' AND updated_at < ?`,
  ).bind(new Date().toISOString(), executionCutoff).run().catch(() => {});
  await env.DB.prepare(
    `UPDATE payment_attempts SET settlement_state='pending', failure_code='execution_recovered',
       result_saved_at=COALESCE(result_saved_at, updated_at), updated_at=?
     WHERE settlement_state='executing' AND updated_at < ?
       AND EXISTS (
         SELECT 1 FROM business_calls
         WHERE business_calls.id=payment_attempts.business_call_id
           AND business_calls.result_json IS NOT NULL
       )`,
  ).bind(new Date().toISOString(), executionCutoff).run().catch(() => {});
  await env.DB.prepare(
    `UPDATE payment_attempts SET settlement_state='handler_failed',
       failure_code='execution_timeout', recovery_payload=NULL, updated_at=?
     WHERE settlement_state='executing' AND updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM business_calls
         WHERE business_calls.id=payment_attempts.business_call_id
           AND business_calls.result_json IS NOT NULL
       )`,
  ).bind(new Date().toISOString(), executionCutoff).run().catch(() => {});
  await env.DB.prepare(
    `UPDATE business_calls SET execution_state='failed', updated_at=?
     WHERE execution_state='executing' AND created_at < ? AND delivery_state='withheld'
       AND result_json IS NULL`,
  ).bind(new Date().toISOString(), executionCutoff).run().catch(() => {});
  // `settling` is a lease held by the request or cron invocation currently
  // talking to the facilitator. Only reclaim a genuinely stale lease; a
  // fresh in-flight settlement must never be submitted concurrently.
  const settlementLeaseCutoff = new Date(Date.now() - 90e3).toISOString();
  const rows = await env.DB.prepare(
    `SELECT payment_identifier, business_call_id, recovery_payload, receipt_json, network,
            asset, amount_atomic, known_fee_micros, recipient, eligible_mainnet, business_calls.units,
            payment_attempts.updated_at
     FROM payment_attempts
     JOIN business_calls ON business_calls.id=payment_attempts.business_call_id
     WHERE (payment_attempts.settlement_state='pending'
            OR (payment_attempts.settlement_state='settling' AND payment_attempts.updated_at < ?))
       AND payment_attempts.recovery_payload IS NOT NULL
     ORDER BY payment_attempts.updated_at ASC LIMIT ?`,
  ).bind(settlementLeaseCutoff, Math.max(1, Math.min(limit, 20))).all<{
    payment_identifier: string;
    business_call_id: string;
    recovery_payload: string;
    receipt_json: string | null;
    network: string;
    asset: string;
    amount_atomic: string;
    known_fee_micros: number;
    recipient: string;
    eligible_mainnet: number;
    units: number;
    updated_at: string;
  }>();
  let completed = 0;
  for (const row of rows.results ?? []) {
    try {
      const rowMode = row.network === BASE_MAINNET
        ? "mainnet"
        : row.network === BASE_SEPOLIA
          ? "testnet"
          : null;
      if (!rowMode) continue;
      const runtime = runtimeOverride && runtimeOverride.network === row.network
        ? runtimeOverride
        : await paymentRuntime({ ...env, PAYMENT_MODE: rowMode }, true);
      const claimedAt = new Date().toISOString();
      const claim = await env.DB.prepare(
        `UPDATE payment_attempts SET settlement_state='settling', updated_at=?
         WHERE payment_identifier=? AND updated_at=?
           AND settlement_state IN ('pending','settling')`,
      ).bind(claimedAt, row.payment_identifier, row.updated_at).run();
      if (Number(claim.meta?.changes ?? 0) !== 1) continue;
      const recovery = await decryptRecovery<{
        payload: PaymentPayload;
        requirements: PaymentRequirements;
        extensions: Record<string, unknown>;
      }>(env.PAYMENT_RECOVERY_SECRET, row.recovery_payload);
      const recorded = row.receipt_json ? JSON.parse(row.receipt_json) as SettleResponse : null;
      const settlement = recorded?.success
        ? recorded
        : await runtime.server.settlePayment(recovery.payload, recovery.requirements, recovery.extensions);
      if (!settlement.success) {
        // A facilitator-declared pending result releases the lease for the
        // next bounded cron. Explicit terminal failures close the attempt.
        if (settlement.errorReason === "settlement_pending") {
          await env.DB.prepare(
            `UPDATE payment_attempts SET settlement_state='pending', failure_code=?, updated_at=?
             WHERE payment_identifier=? AND settlement_state='settling' AND updated_at=?`,
          ).bind("settlement_pending", new Date().toISOString(), row.payment_identifier, claimedAt).run();
        } else {
          await env.DB.prepare(
            `UPDATE payment_attempts SET settlement_state='failed', failure_code=?,
             receipt_json=?, recovery_payload=NULL, updated_at=?
             WHERE payment_identifier=? AND settlement_state IN ('pending','settling')`,
          ).bind(
            settlement.errorReason ?? settlement.errorMessage ?? "settlement_failed",
            canonicalJson(settlement),
            new Date().toISOString(),
            row.payment_identifier,
          ).run();
          await env.DB.prepare(
            `UPDATE business_calls SET execution_state='failed', updated_at=?
             WHERE id=? AND delivery_state='withheld'`,
          ).bind(new Date().toISOString(), row.business_call_id).run().catch(() => {});
          await saveEvent(env, row.payment_identifier, row.business_call_id, "settlement_failed");
        }
        continue;
      }
      const transaction = settlementTransaction(settlement);
      if (!transaction || !settlementMatchesRequirements(settlement, row.network, row.amount_atomic)) {
        await env.DB.prepare(
          `UPDATE payment_attempts SET settlement_state='pending',
           failure_code='invalid_settlement_receipt', receipt_json=NULL, updated_at=?
           WHERE payment_identifier=? AND settlement_state='settling' AND updated_at=?`,
        ).bind(new Date().toISOString(), row.payment_identifier, claimedAt).run();
        continue;
      }
      if (await duplicateTransactionOwner(env, transaction, row.payment_identifier)) {
        await env.DB.prepare(
          `UPDATE payment_attempts SET settlement_state='failed', failure_code='duplicate_transaction',
           receipt_json=?, recovery_payload=NULL, updated_at=? WHERE payment_identifier=?`,
        ).bind(canonicalJson(settlement), new Date().toISOString(), row.payment_identifier).run();
        await env.DB.prepare(
          `UPDATE business_calls SET execution_state='failed', updated_at=?
           WHERE id=? AND delivery_state='withheld'`,
        ).bind(new Date().toISOString(), row.business_call_id).run().catch(() => {});
        await saveEvent(env, row.payment_identifier, row.business_call_id, "settlement_failed", {
          reason: "duplicate_transaction",
        });
        continue;
      }
      // Preserve the eligibility decision made before the original settlement
      // attempt while re-checking the immutable payment terms.  This keeps a
      // successfully reconciled mainnet payment revenue-eligible, without
      // allowing a stale or tampered recovery row to broaden eligibility.
      const eligibleMainnet =
        row.eligible_mainnet === 1 &&
        mode === "mainnet" &&
        row.network === BASE_MAINNET &&
        row.asset.toLowerCase() === BASE_USDC.toLowerCase() &&
        row.amount_atomic === String(ANALYSIS_UNIT_PRICE_MICROS * row.units) &&
        row.recipient.toLowerCase() === (env.X402_PAY_TO ?? "").toLowerCase() &&
        true;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE payment_attempts SET settlement_state='settled', receipt_json=?, transaction_hash=?,
           settled_at=?, recovery_payload=NULL, updated_at=? WHERE payment_identifier=?`,
        ).bind(canonicalJson(settlement), transaction, new Date().toISOString(), new Date().toISOString(), row.payment_identifier),
        env.DB.prepare(
          `INSERT OR IGNORE INTO billing_ledger_v3
           (payment_identifier, transaction_hash, amount_micros, fee_micros, network, asset,
            recipient, eligible_mainnet, refunded_micros, created_at)
           VALUES (?,?,?,?,?,?,?,?,0,?)`,
        ).bind(
          row.payment_identifier,
          transaction,
          Number(row.amount_atomic),
          row.known_fee_micros,
          row.network,
          row.asset,
          row.recipient,
          eligibleMainnet ? 1 : 0,
          new Date().toISOString(),
        ),
        env.DB.prepare(
          `UPDATE business_calls SET delivery_state='delivered', execution_state='complete',
           delivered_at=?, updated_at=? WHERE id=?`,
        ).bind(new Date().toISOString(), new Date().toISOString(), row.business_call_id),
      ]);
      completed += 1;
    } catch {
      // Bounded cron: leave the exact authorization and encrypted recovery data for the next run.
    }
  }
  return completed;
}

export function isBusinessOperation(value: string): value is OperationName {
  return MCP_BUSINESS_TOOL_NAMES.has(value);
}

export const CONTRACT_OPERATIONS = OPERATION_CATALOG;
