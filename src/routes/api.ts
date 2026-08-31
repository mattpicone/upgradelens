// REST API v1 routes.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  MAX_BATCH_PAIRS,
  ValidationError,
  validateCheckRequest,
  validateEcosystem,
  validatePackageName,
  validateVersion,
} from "../validate";
import { checkUpgrade, planUpgrade, findTarget, getEvidence } from "../service";
import { fetchPackageVersions } from "../sources/depsdev";
import { queryOsv } from "../sources/osv";
import { cycleStatus, eolProductFor, fetchEol } from "../sources/endoflife";
import { cmpVersions, isPre } from "../engine/analyze";
import type { AppVariables } from "../context";
import { readJsonBody } from "../http/body";
import { executeAnalysis, paymentPayloadFromHeader, paymentRequiredHeader, paymentResponseHeader } from "../payment";
import { MachineError, machineError } from "../errors";
import { checkRateLimit } from "../telemetry";

export const api = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function errJson(status: number, code: string, message: string, field?: string) {
  return Response.json(
    machineError(
      code === "upstream_unavailable" ? "upstream_failure" : code,
      message,
      status === 429 || status >= 500,
      field ? { field } : undefined,
    ),
    { status },
  );
}

function handleValidation(e: unknown): Response {
  if (e instanceof MachineError) {
    return Response.json(e.toJSON(), { status: e.status });
  }
  if (e instanceof ValidationError) {
    return errJson(400, e.field === "ecosystem" ? "unsupported_ecosystem" : "invalid_input", e.message, e.field);
  }
  throw e;
}

api.post("/upgrade/check", async (c) => {
  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) return errJson(parsed.status, parsed.code, parsed.message);
  const body = parsed.data;
  try {
    const req = validateCheckRequest(body);
    c.set("meta", { ecosystem: req.ecosystem, package: req.package });
    const outcome = await executeAnalysis({
      env: c.env,
      caller: c.get("caller"),
      requestId: c.get("requestId"),
      operation: "check_dependency_upgrade",
      args: req as unknown as Record<string, unknown>,
      units: 1,
      resource: `${c.env.PUBLIC_BASE_URL}/v1/upgrade/check`,
      paymentPayload: paymentPayloadFromHeader(c.req.header("payment-signature") ?? null),
      businessEligible: c.get("businessEligible"),
      execute: () => checkUpgrade(c.env, req),
    });
    if (outcome.kind === "payment_required") {
      c.header("payment-required", paymentRequiredHeader(outcome.paymentRequired));
      c.header("cache-control", "no-store");
      return c.json(machineError("payment_required", "Payment is required for this analysis.", true), 402);
    }
    if (outcome.kind === "error") return c.json(outcome.body, outcome.status as 400);
    const result = outcome.result;
    if (outcome.paymentResponse) c.header("payment-response", paymentResponseHeader(outcome.paymentResponse));
    c.header("cache-control", "no-store");
    c.set("cacheHit", result.cache_hit === true);
    c.set("unknownResult", result.decision === "unknown");
    return c.json(result);
  } catch (e) {
    return handleValidation(e);
  }
});

api.post("/upgrade/plan", async (c) => {
  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) return errJson(parsed.status, parsed.code, parsed.message);
  const body = parsed.data;
  try {
    const req = validateCheckRequest(body);
    c.set("meta", { ecosystem: req.ecosystem, package: req.package });
    const outcome = await executeAnalysis({
      env: c.env,
      caller: c.get("caller"),
      requestId: c.get("requestId"),
      operation: "plan_dependency_upgrade",
      args: req as unknown as Record<string, unknown>,
      units: 1,
      resource: `${c.env.PUBLIC_BASE_URL}/v1/upgrade/plan`,
      paymentPayload: paymentPayloadFromHeader(c.req.header("payment-signature") ?? null),
      businessEligible: c.get("businessEligible"),
      execute: () => planUpgrade(c.env, req),
    });
    if (outcome.kind === "payment_required") {
      c.header("payment-required", paymentRequiredHeader(outcome.paymentRequired));
      c.header("cache-control", "no-store");
      return c.json(machineError("payment_required", "Payment is required for this analysis.", true), 402);
    }
    if (outcome.kind === "error") return c.json(outcome.body, outcome.status as 400);
    const result = outcome.result;
    if (outcome.paymentResponse) c.header("payment-response", paymentResponseHeader(outcome.paymentResponse));
    c.header("cache-control", "no-store");
    c.set("cacheHit", result.cache_hit === true);
    c.set("unknownResult", result.decision === "unknown");
    return c.json(result);
  } catch (e) {
    return handleValidation(e);
  }
});

api.post("/upgrade/batch", async (c) => {
  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) return errJson(parsed.status, parsed.code, parsed.message);
  const body = parsed.data;
  const pairs = (body as { pairs?: unknown[] })?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return errJson(400, "invalid_request", "Body must contain a non-empty 'pairs' array.");
  }
  if (pairs.length > MAX_BATCH_PAIRS) {
    return errJson(
      400,
      "batch_too_large",
      `Batch is limited to ${MAX_BATCH_PAIRS} pairs per request. Split larger manifests across requests.`,
    );
  }
  try {
    const reqs = pairs.map((p) => validateCheckRequest(p));
    if (reqs.length > 1) {
      // The global middleware accounts for the first unit. Add the remaining
      // pair units before doing any upstream work so a batch cannot bypass
      // caller/global daily fuses.
      const extra = await checkRateLimit(c.env, c.get("caller"), {
        skipEdge: true,
        units: reqs.length - 1,
      });
      c.header("x-ratelimit-remaining-day", String(extra.remaining_day));
      if (!extra.allowed) {
        return errJson(429, "rate_limited", "The request rate is temporarily limited. Retry after the indicated delay.");
      }
    }
    const execute = async () => {
      const results = await Promise.all(reqs.map((r) => checkUpgrade(c.env, r)));
      return {
        summary: {
          total: results.length,
          proceed: results.filter((r) => r.decision === "proceed").length,
          review_required: results.filter((r) => r.decision === "review_required").length,
          block: results.filter((r) => r.decision === "block").length,
          unknown: results.filter((r) => r.decision === "unknown").length,
        },
        results,
      };
    };
    const outcome = await executeAnalysis({
      env: c.env,
      caller: c.get("caller"),
      requestId: c.get("requestId"),
      operation: "batch_check_upgrades",
      args: { pairs: reqs },
      units: reqs.length,
      resource: `${c.env.PUBLIC_BASE_URL}/v1/upgrade/batch`,
      paymentPayload: paymentPayloadFromHeader(c.req.header("payment-signature") ?? null),
      businessEligible: c.get("businessEligible"),
      execute,
    });
    if (outcome.kind === "payment_required") {
      c.header("payment-required", paymentRequiredHeader(outcome.paymentRequired));
      c.header("cache-control", "no-store");
      return c.json(machineError("payment_required", `Payment is required for ${reqs.length} analysis units.`, true), 402);
    }
    if (outcome.kind === "error") return c.json(outcome.body, outcome.status as 400);
    const { results, summary } = outcome.result;
    if (outcome.paymentResponse) c.header("payment-response", paymentResponseHeader(outcome.paymentResponse));
    c.header("cache-control", "no-store");
    c.set("cacheHit", results.every((r) => r.cache_hit === true));
    c.set("unknownResult", summary.unknown > 0);
    return c.json(outcome.result);
  } catch (e) {
    return handleValidation(e);
  }
});

api.post("/upgrade/target", async (c) => {
  const parsed = await readJsonBody(c.req.raw);
  if (!parsed.ok) return errJson(parsed.status, parsed.code, parsed.message);
  const body = parsed.data;
  try {
    const b = body as Record<string, unknown>;
    const eco = validateEcosystem(b.ecosystem);
    const pkg = validatePackageName(eco, b.package);
    const cur = validateVersion("current_version", b.current_version);
    const maxMajorJump =
      typeof b.max_major_jump === "number" && b.max_major_jump >= 0
        ? Math.floor(b.max_major_jump)
        : undefined;
    c.set("meta", { ecosystem: eco, package: pkg });
    const normalized = {
      ecosystem: eco,
      package: pkg,
      current_version: cur,
      ...(maxMajorJump !== undefined ? { max_major_jump: maxMajorJump } : {}),
      allow_prerelease: b.allow_prerelease === true,
    };
    const outcome = await executeAnalysis({
      env: c.env,
      caller: c.get("caller"),
      requestId: c.get("requestId"),
      operation: "find_safe_upgrade_target",
      args: normalized,
      units: 1,
      resource: `${c.env.PUBLIC_BASE_URL}/v1/upgrade/target`,
      paymentPayload: paymentPayloadFromHeader(c.req.header("payment-signature") ?? null),
      businessEligible: c.get("businessEligible"),
      execute: () => findTarget(c.env, eco, pkg, cur, {
        maxMajorJump,
        allowPrerelease: b.allow_prerelease === true,
      }),
    });
    if (outcome.kind === "payment_required") {
      c.header("payment-required", paymentRequiredHeader(outcome.paymentRequired));
      c.header("cache-control", "no-store");
      return c.json(machineError("payment_required", "Payment is required for this analysis.", true), 402);
    }
    if (outcome.kind === "error") return c.json(outcome.body, outcome.status as 400);
    const result = outcome.result;
    if (outcome.paymentResponse) c.header("payment-response", paymentResponseHeader(outcome.paymentResponse));
    c.header("cache-control", "no-store");
    c.set("unknownResult", result.candidates.length === 0 && result.confidence < 0.5);
    return c.json(result);
  } catch (e) {
    return handleValidation(e);
  }
});

api.get("/package/:ecosystem/:name{.+}", async (c) => {
  try {
    const eco = validateEcosystem(c.req.param("ecosystem"));
    const name = validatePackageName(eco, decodeURIComponent(c.req.param("name")));
    c.set("meta", { ecosystem: eco, package: name });

    const listing = await fetchPackageVersions(eco, name);
    if (!listing.ok || !listing.data) {
      return errJson(
        listing.status === 404 ? 404 : 502,
        listing.status === 404 ? "not_found" : "upstream_unavailable",
        listing.status === 404
          ? `Package ${name} was not found for ecosystem ${eco}.`
          : "Upstream package data is currently unavailable.",
      );
    }
    const stable = listing.data.versions.filter((v) => !isPre(eco, v.version));
    const latestStable =
      stable.length > 0
        ? stable.reduce((best, v) =>
            (cmpVersions(eco, v.version, best.version) ?? -1) > 0 ? v : best,
          ).version
        : null;
    const latest = latestStable ?? listing.data.default_version;

    const [advisories, eol] = await Promise.all([
      latest ? queryOsv(eco, name, latest) : Promise.resolve(null),
      (() => {
        const product = eolProductFor(eco, name);
        return product ? fetchEol(product) : Promise.resolve(null);
      })(),
    ]);

    return c.json({
      ecosystem: eco,
      package: name,
      latest_stable: latestStable,
      default_version: listing.data.default_version,
      version_count: listing.data.versions.length,
      recent_versions: listing.data.versions
        .slice()
        .sort((a, b) => (cmpVersions(eco, a.version, b.version) ?? 0) * -1)
        .slice(0, 15),
      advisories_affecting_latest: advisories?.ok ? advisories.data : null,
      eol:
        eol?.ok && eol.data && latest
          ? cycleStatus(eol.data.cycles, latest)
          : null,
      sources: {
        deps_dev: listing.data.source_url,
        osv: `https://osv.dev/list?q=${encodeURIComponent(name)}`,
      },
      freshness: listing.fetched_at,
    });
  } catch (e) {
    return handleValidation(e);
  }
});

api.get("/evidence/:id", async (c) => {
  const row = await getEvidence(c.env, c.req.param("id"));
  if (!row) return errJson(404, "not_found", "Evidence record not found.");
  return c.json(row);
});

api.post("/keys", (c) =>
  c.json(
    machineError(
      "not_found",
      "New API keys are no longer issued. Accounts and keys are not required; use the shared rolling trial and x402 payment flow.",
      false,
    ),
    410,
  ),
);
