// Machine documentation surfaces: OpenAPI, llms.txt, pricing.json, healthz, landing.

import { Hono } from "hono";
import type { Env } from "../types";
import { PRICING, paymentActivation } from "../billing";
import type { AppVariables } from "../context";

export const meta = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const decisionEnum = ["proceed", "review_required", "block", "unknown"];

function openapiSpec(env: Env) {
  const base = env.PUBLIC_BASE_URL;
  const evidence = {
    type: "object",
    properties: {
      id: { type: "string" },
      source_type: { type: "string" },
      source_url: { type: "string" },
      fact: { type: "string" },
      confidence: { type: "number" },
      fetched_at: { type: "string", format: "date-time" },
    },
  };
  const checkRequest = {
    type: "object",
    required: ["ecosystem", "package", "current_version", "target_version"],
    properties: {
      ecosystem: { type: "string", enum: ["npm", "pypi"] },
      package: { type: "string", maxLength: 214 },
      current_version: { type: "string", maxLength: 64 },
      target_version: { type: "string", maxLength: 64 },
      runtime: {
        type: "object",
        properties: {
          node: { type: "string", description: "Node.js version in use, e.g. 20.11.0" },
          python: { type: "string", description: "Python version in use, e.g. 3.12" },
        },
      },
    },
  };
  const checkResult = {
    type: "object",
    properties: {
      decision: { type: "string", enum: decisionEnum },
      action_allowed: { type: "boolean" },
      risk_score: { type: "integer", minimum: 0, maximum: 100 },
      ecosystem: { type: "string" },
      package: { type: "string" },
      current_version: { type: "string" },
      target_version: { type: "string" },
      latest_stable: { type: ["string", "null"] },
      repository_url: { type: ["string", "null"] },
      version_facts: { type: "object" },
      security_delta: { type: "object" },
      compatibility: { type: "object" },
      breaking_changes: { type: "array", items: { type: "object" } },
      reasons: { type: "array", items: { type: "string" } },
      claim_evidence: { type: "array", items: { type: "object" } },
      evidence: { type: "array", items: evidence },
      coverage: { type: "object" },
      confidence: { type: "number" },
      freshness: { type: "string", format: "date-time" },
      analysis_version: { type: "string" },
      cache_hit: { type: "boolean" },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "UpgradeLens",
      version: env.SERVICE_VERSION,
      description:
        "Evidence-backed dependency upgrade intelligence for AI coding agents. One call answers: should this dependency move from version A to version B, and what must be handled? Deterministic, source-cited, no hallucinated migration facts. Free evaluation quota. Remote MCP endpoint at /mcp.",
      contact: { url: "https://github.com/mattpicone/upgradelens" },
    },
    servers: [{ url: base }],
    paths: {
      "/v1/upgrade/check": {
        post: {
          operationId: "checkDependencyUpgrade",
          summary:
            "Decide whether a dependency can move from current_version to target_version (security, compatibility, EOL, breaking-change evidence).",
          requestBody: {
            required: true,
            content: { "application/json": { schema: checkRequest } },
          },
          responses: {
            "200": { description: "Upgrade decision", content: { "application/json": { schema: checkResult } } },
            "400": { description: "Invalid request" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/v1/upgrade/plan": {
        post: {
          operationId: "planDependencyUpgrade",
          summary:
            "Check plus ordered, source-cited migration actions and changelog URLs.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: checkRequest } },
          },
          responses: { "200": { description: "Upgrade plan with migration_actions[] and changelog_urls[]" } },
        },
      },
      "/v1/upgrade/target": {
        post: {
          operationId: "findUpgradeCandidates",
          summary:
            "Rank candidate target versions when the target is not yet known; every candidate requires a full check before editing.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ecosystem", "package", "current_version"],
                  properties: {
                    ecosystem: { type: "string", enum: ["npm", "pypi"] },
                    package: { type: "string" },
                    current_version: { type: "string" },
                    max_major_jump: { type: "integer", minimum: 0 },
                    allow_prerelease: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Ranked candidates with per-candidate rationale" } },
        },
      },
      "/v1/upgrade/batch": {
        post: {
          operationId: "batchCheckUpgrades",
          summary: "Check up to 3 version pairs in one request; each pair consumes one daily analysis unit.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pairs"],
                  properties: { pairs: { type: "array", maxItems: 3, items: checkRequest } },
                },
              },
            },
          },
          responses: { "200": { description: "Summary plus per-pair results" } },
        },
      },
      "/v1/package/{ecosystem}/{name}": {
        get: {
          operationId: "getPackageSnapshot",
          summary: "Current package snapshot: latest stable, recent versions, advisories, EOL.",
          parameters: [
            { name: "ecosystem", in: "path", required: true, schema: { type: "string", enum: ["npm", "pypi"] } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Package snapshot" }, "404": { description: "Unknown package" } },
        },
      },
      "/v1/evidence/{id}": {
        get: {
          operationId: "getEvidence",
          summary: "Resolve an evidence ID to its provenance record.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Evidence record" }, "404": { description: "Not found" } },
        },
      },
      "/v1/keys": {
        post: {
          operationId: "createApiKey",
          summary: "Instantly create a free API key (higher rate limits than anonymous).",
          responses: { "201": { description: "New API key" } },
        },
      },
      "/healthz": {
        get: {
          operationId: "health",
          summary: "Service health, version and source freshness.",
          responses: { "200": { description: "Health status" } },
        },
      },
    },
  };
}

meta.get("/openapi.json", (c) => c.json(openapiSpec(c.env)));

meta.get("/pricing.json", (c) =>
  c.json({
    service: "UpgradeLens",
    updated: "2026-08-28",
    mode: paymentActivation(c.env).requested ? "activation_blocked" : "free_validation",
    payment_activation: paymentActivation(c.env),
    ...PRICING,
  }),
);

meta.get("/llms.txt", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  return c.text(`# UpgradeLens

> Evidence-backed dependency upgrade intelligence for AI coding agents. One deterministic, source-cited call answers whether and how a software dependency should move from version A to version B (npm + PyPI). Compresses registry metadata, OSV vulnerability deltas, dependency diffs, runtime compatibility, EOL state and documented breaking changes into a single structured response with decision proceed|review_required|block|unknown.

Use this service when you are about to edit dependency files (package.json, requirements.txt, pyproject.toml) and need current, verified upgrade facts. Do not use it merely to install a package or search documentation.

## API
- [OpenAPI spec](${base}/openapi.json): all REST endpoints
- POST ${base}/v1/upgrade/check — decision for a known version pair
- POST ${base}/v1/upgrade/plan — decision + ordered migration actions
- POST ${base}/v1/upgrade/target — ranked candidates when target unknown
- GET ${base}/v1/package/{ecosystem}/{name} — package snapshot
- GET ${base}/healthz — health/freshness

## MCP
- Remote MCP endpoint (streamable HTTP): ${base}/mcp
- Tools: check_dependency_upgrade, find_safe_upgrade_target, plan_dependency_upgrade

## Access
- Anonymous free quota available. Higher limits: POST ${base}/v1/keys (instant, free).
- Pricing metadata: ${base}/pricing.json

## Provenance
- Sources: deps.dev, OSV.dev, registry.npmjs.org, pypi.org, endoflife.date
- Every semantic claim carries evidence with source URL and fetch timestamp.
`);
});

meta.get("/healthz", async (c) => {
  let dbOk = false;
  let telemetrySchemaOk = false;
  let analysisFreshness: string | null = null;
  let enrichmentFreshness: string | null = null;
  try {
    const [analysis, enrichment, telemetrySchema] = await Promise.all([
      c.env.DB.prepare(
        `SELECT last_success_at FROM source_snapshots WHERE source='analysis'`,
      ).first<{ last_success_at: string }>(),
      c.env.DB.prepare(
        `SELECT last_success_at FROM source_snapshots WHERE source='github_enrichment'`,
      ).first<{ last_success_at: string }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) columns_present FROM pragma_table_info('mcp_events')
         WHERE name IN ('actor_class','classification_version','event_kind','requested_tool',
                        'tool_invoked','tool_success','owned_test')`,
      ).first<{ columns_present: number }>(),
    ]);
    dbOk = true;
    telemetrySchemaOk = telemetrySchema?.columns_present === 7;
    analysisFreshness = analysis?.last_success_at ?? null;
    enrichmentFreshness = enrichment?.last_success_at ?? null;
  } catch {
    dbOk = false;
  }
  const ageMs = (value: string | null) => value ? Date.now() - new Date(value).getTime() : null;
  const analysisStale = analysisFreshness !== null && (ageMs(analysisFreshness) ?? 0) > 24 * 3600e3;
  const enrichmentStale = enrichmentFreshness !== null && (ageMs(enrichmentFreshness) ?? 0) > 8 * 864e5;
  const enrichmentMissingAfterUse = analysisFreshness !== null && enrichmentFreshness === null;
  const degraded =
    !dbOk || !telemetrySchemaOk || analysisStale || enrichmentStale || enrichmentMissingAfterUse;
  return c.json({
    status: degraded ? "degraded" : "ok",
    service: "upgradelens",
    version: c.env.SERVICE_VERSION,
    analysis_version: c.env.ANALYSIS_VERSION,
    db: dbOk ? "ok" : "unavailable",
    telemetry_schema: telemetrySchemaOk ? "ok" : "missing_or_outdated",
    last_analysis_at: analysisFreshness,
    last_breaking_change_enrichment_at: enrichmentFreshness,
    freshness: {
      analysis: analysisStale ? "stale" : analysisFreshness ? "fresh" : "idle",
      breaking_changes: enrichmentStale
        ? "stale"
        : enrichmentFreshness
          ? "fresh"
          : "not_run",
    },
    time: new Date().toISOString(),
  });
});

meta.get("/", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UpgradeLens — dependency upgrade intelligence for AI agents</title>
<meta name="description" content="One deterministic, source-cited API/MCP call answers whether and how a dependency should move from version A to version B. npm + PyPI. Built for coding agents.">
<style>
:root{--bg:#0b0e14;--panel:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#5eead4;--accent2:#818cf8}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:880px;margin:0 auto;padding:48px 24px}
h1{font-size:2.2rem;margin:.2em 0}.tag{color:var(--accent);font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem}
p.lead{color:var(--muted);font-size:1.1rem}
pre{background:var(--panel);padding:16px;border-radius:10px;overflow-x:auto;font-size:.85rem;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--accent2)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:32px 0}
.card{background:var(--panel);border-radius:10px;padding:20px}.card h3{margin-top:0;font-size:1rem}
.card p{color:var(--muted);font-size:.9rem;margin-bottom:0}
footer{color:var(--muted);font-size:.85rem;margin-top:48px;border-top:1px solid #232a3d;padding-top:24px}
</style></head><body><main>
<div class="tag">For AI coding agents</div>
<h1>UpgradeLens</h1>
<p class="lead">One deterministic, source-cited call answers: <em>should this dependency move from version A to version B, and what must be handled?</em> Security delta, runtime compatibility, dependency diff, EOL state and documented breaking changes — npm and PyPI.</p>
<div class="grid">
<div class="card"><h3>Remote MCP</h3><p><code>${base}/mcp</code><br>Tools: <code>check_dependency_upgrade</code>, <code>find_safe_upgrade_target</code>, <code>plan_dependency_upgrade</code></p></div>
<div class="card"><h3>REST API</h3><p><a href="${base}/openapi.json">OpenAPI spec</a> · <a href="${base}/llms.txt">llms.txt</a> · <a href="${base}/pricing.json">pricing</a> · <a href="${base}/healthz">health</a></p></div>
<div class="card"><h3>Evidence, not vibes</h3><p>Every claim cites deps.dev, OSV, npm, PyPI or endoflife.date with URL + timestamp. Returns <code>unknown</code> rather than guessing.</p></div>
</div>
<h2>Add to Cursor / Claude Code / any MCP client</h2>
<pre><code>{
  "mcpServers": {
    "upgradelens": { "url": "${base}/mcp" }
  }
}</code></pre>
<h2>Or call it directly</h2>
<pre><code>curl -X POST ${base}/v1/upgrade/check \\
  -H 'content-type: application/json' \\
  -d '{"ecosystem":"npm","package":"express","current_version":"4.19.2","target_version":"5.1.0","runtime":{"node":"20.11.0"}}'</code></pre>
<footer>Free evaluation quota, no signup. Higher limits: <code>POST ${base}/v1/keys</code>. Read-only service — it never executes commands or fetches caller-supplied URLs. <a href="https://github.com/mattpicone/upgradelens">Source & docs</a>.</footer>
</main></body></html>`);
});
