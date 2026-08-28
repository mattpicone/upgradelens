// Service layer: D1-backed caching, evidence persistence and source freshness
// around the pure analysis engine.

import type {
  Env,
  UpgradeCheckRequest,
  UpgradeCheckResult,
  UpgradePlanResult,
  FindTargetResult,
  SourceCoverage,
} from "./types";
import {
  analyzeUpgrade,
  buildPlan,
  type BreakingChangeRow,
} from "./engine/analyze";
import { findSafeTarget } from "./engine/target";
import { reserveCacheMiss } from "./telemetry";

const PAIR_TTL_MS = 6 * 60 * 60 * 1000; // 6h freshness for cached pair analyses
const UNKNOWN_PAIR_TTL_MS = 5 * 60 * 1000; // short outage cache prevents retry amplification
const MAX_PERSISTED_EVIDENCE = 12;

function runtimeKey(req: UpgradeCheckRequest): string {
  const r = req.runtime;
  if (!r) return "";
  return [r.node ? `node:${r.node}` : "", r.python ? `py:${r.python}` : ""]
    .filter(Boolean)
    .join(",");
}

const CURATED_BREAKING_PACKAGES = new Set([
  "npm:express", "npm:react", "npm:next", "npm:vue", "npm:typescript", "npm:eslint",
  "npm:vite", "npm:axios", "npm:jest", "npm:webpack", "npm:tailwindcss", "npm:zod",
  "pypi:django", "pypi:fastapi", "pypi:flask", "pypi:requests", "pypi:pydantic",
  "pypi:sqlalchemy", "pypi:numpy", "pypi:pandas", "pypi:httpx", "pypi:celery",
]);

export async function loadBreakingChanges(
  env: Env,
  ecosystem: string,
  pkg: string,
): Promise<{ rows: BreakingChangeRow[]; coverage: SourceCoverage }> {
  try {
    const [rows, snapshot] = await Promise.all([
      env.DB.prepare(
        `SELECT version, summary, severity, source_url, confidence, fetched_at
         FROM breaking_changes WHERE ecosystem = ? AND package = ?
         ORDER BY fetched_at DESC, id DESC`,
      ).bind(ecosystem, pkg).all<BreakingChangeRow>(),
      env.DB.prepare(
        `SELECT last_success_at FROM source_snapshots WHERE source='github_enrichment'`,
      ).first<{ last_success_at: string | null }>(),
    ]);
    const result = rows.results ?? [];
    const curated = CURATED_BREAKING_PACKAGES.has(`${ecosystem}:${pkg.toLowerCase()}`);
    if (!curated && result.length === 0) {
      return {
        rows: [],
        coverage: {
          status: "not_covered",
          as_of: snapshot?.last_success_at ?? null,
          detail: "This package is outside the curated release-note enrichment set.",
        },
      };
    }
    if (!snapshot?.last_success_at) {
      return {
        rows: result,
        coverage: {
          status: "unavailable",
          as_of: null,
          detail: "Release-note enrichment has not completed successfully.",
        },
      };
    }
    return {
      rows: result,
      coverage: {
        status: "partial",
        as_of: snapshot.last_success_at,
        detail: "Deterministic extraction covers the 30 most recent GitHub releases for curated packages.",
      },
    };
  } catch {
    return {
      rows: [],
      coverage: {
        status: "unavailable",
        as_of: null,
        detail: "Breaking-change storage could not be read.",
      },
    };
  }
}

async function getCachedPair(
  env: Env,
  req: UpgradeCheckRequest,
): Promise<UpgradeCheckResult | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT response_json, fresh_at FROM upgrade_pairs
       WHERE ecosystem=? AND package=? AND from_version=? AND to_version=?
         AND runtime_key=? AND analysis_version=?`,
    )
      .bind(
        req.ecosystem,
        req.package,
        req.current_version,
        req.target_version,
        runtimeKey(req),
        env.ANALYSIS_VERSION,
      )
      .first<{ response_json: string; fresh_at: string }>();
    if (!row) return null;
    const parsed = JSON.parse(row.response_json) as UpgradeCheckResult;
    const ttl = parsed.decision === "unknown" ? UNKNOWN_PAIR_TTL_MS : PAIR_TTL_MS;
    if (Date.now() - new Date(row.fresh_at).getTime() > ttl) return null;
    parsed.cache_hit = true;
    return parsed;
  } catch {
    return null;
  }
}

async function savePair(
  env: Env,
  req: UpgradeCheckRequest,
  result: UpgradeCheckResult,
): Promise<void> {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO upgrade_pairs
         (ecosystem, package, from_version, to_version, runtime_key, analysis_version,
          decision, risk_score, response_json, fresh_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(ecosystem, package, from_version, to_version, runtime_key, analysis_version)
       DO UPDATE SET decision=excluded.decision, risk_score=excluded.risk_score,
         response_json=excluded.response_json, fresh_at=excluded.fresh_at`,
    ).bind(
      req.ecosystem,
      req.package,
      req.current_version,
      req.target_version,
      runtimeKey(req),
      env.ANALYSIS_VERSION,
      result.decision,
      result.risk_score,
      JSON.stringify(result),
      result.freshness,
    ),
  ];
  // Persist evidence for GET /v1/evidence/{id} resolution (bounded, idempotent).
  for (const e of result.evidence.slice(0, MAX_PERSISTED_EVIDENCE)) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO release_evidence
           (id, ecosystem, package, version, source_type, source_url, fact, confidence, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        e.id,
        req.ecosystem,
        req.package,
        req.target_version,
        e.source_type,
        e.source_url,
        e.fact,
        e.confidence,
        e.fetched_at,
      ),
    );
  }
  // An unknown result is useful as a very short negative cache, but it must not
  // make health reporting claim a successful analysis refresh.
  if (result.decision !== "unknown") {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO source_snapshots (source, last_success_at) VALUES ('analysis', ?)
         ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at`,
      ).bind(result.freshness),
    );
  }
  if (result.decision !== "unknown" && result.repository_url) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO packages (ecosystem, name, repository_url, latest_stable, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(ecosystem, name) DO UPDATE SET repository_url=excluded.repository_url,
           latest_stable=excluded.latest_stable, updated_at=excluded.updated_at`,
      ).bind(req.ecosystem, req.package, result.repository_url, result.latest_stable, result.freshness),
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch {
    // cache write failures must never break responses
  }
}

export async function checkUpgrade(
  env: Env,
  req: UpgradeCheckRequest,
): Promise<UpgradeCheckResult> {
  const cached = await getCachedPair(env, req);
  if (cached) return cached;
  if (!(await reserveCacheMiss(env))) {
    const now = new Date().toISOString();
    const unavailable: SourceCoverage = {
      status: "unavailable",
      as_of: null,
      detail: "The daily cache-miss safety budget is exhausted; no upstream claims were made.",
    };
    return {
      decision: "unknown",
      action_allowed: false,
      risk_score: 50,
      ecosystem: req.ecosystem,
      package: req.package,
      current_version: req.current_version,
      target_version: req.target_version,
      latest_stable: null,
      repository_url: null,
      version_facts: {
        current_published_at: null,
        target_published_at: null,
        current_yanked: false,
        target_yanked: false,
        package_deprecated: false,
        target_deprecation_message: null,
        is_downgrade: false,
        semver_jump: "unknown",
        versions_between: null,
      },
      security_delta: {
        advisories_affecting_current: [],
        advisories_fixed_by_target: [],
        advisories_affecting_target: [],
      },
      compatibility: {
        runtime_supported: null,
        runtime_notes: [],
        dependency_changes: null,
        license_change: null,
      },
      breaking_changes: [],
      reasons: ["Daily cache-miss safety budget exhausted; retry after 00:00 UTC."],
      claim_evidence: [],
      evidence: [],
      coverage: {
        registry: unavailable,
        osv: unavailable,
        deps_dev: unavailable,
        eol: unavailable,
        breaking_changes: unavailable,
      },
      confidence: 0.2,
      freshness: now,
      analysis_version: env.ANALYSIS_VERSION,
      cache_hit: false,
    };
  }
  const breaking = await loadBreakingChanges(env, req.ecosystem, req.package);
  const result = await analyzeUpgrade(req, {
    breakingChanges: breaking.rows,
    breakingCoverage: breaking.coverage,
  });
  result.analysis_version = env.ANALYSIS_VERSION;
  result.cache_hit = false;
  await savePair(env, req, result);
  return result;
}

export async function planUpgrade(env: Env, req: UpgradeCheckRequest): Promise<UpgradePlanResult> {
  const check = await checkUpgrade(env, req);
  return buildPlan(check, check.repository_url);
}

export async function findTarget(
  env: Env,
  ecosystem: "npm" | "pypi",
  pkg: string,
  currentVersion: string,
  opts: { maxMajorJump?: number; allowPrerelease?: boolean } = {},
): Promise<FindTargetResult> {
  const result = await findSafeTarget(ecosystem, pkg, currentVersion, opts);
  result.analysis_version = env.ANALYSIS_VERSION;
  return result;
}

export async function getEvidence(env: Env, id: string) {
  if (!/^ev_[a-z0-9]{1,32}$/.test(id)) return null;
  try {
    return await env.DB.prepare(
      `SELECT id, ecosystem, package, version, source_type, source_url, fact, confidence, fetched_at
       FROM release_evidence WHERE id = ?`,
    )
      .bind(id)
      .first();
  } catch {
    return null;
  }
}
