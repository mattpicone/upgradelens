// Service layer: D1-backed caching, evidence persistence and source freshness
// around the pure analysis engine.

import type {
  Env,
  UpgradeCheckRequest,
  UpgradeCheckResult,
  UpgradePlanResult,
  FindTargetResult,
} from "./types";
import {
  analyzeUpgrade,
  buildPlan,
  type BreakingChangeRow,
} from "./engine/analyze";
import { findSafeTarget } from "./engine/target";

const PAIR_TTL_MS = 6 * 60 * 60 * 1000; // 6h freshness for cached pair analyses

function runtimeKey(req: UpgradeCheckRequest): string {
  const r = req.runtime;
  if (!r) return "";
  return [r.node ? `node:${r.node}` : "", r.python ? `py:${r.python}` : ""]
    .filter(Boolean)
    .join(",");
}

export async function loadBreakingChanges(
  env: Env,
  ecosystem: string,
  pkg: string,
): Promise<BreakingChangeRow[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT version, summary, severity, source_url, confidence, fetched_at
       FROM breaking_changes WHERE ecosystem = ? AND package = ? LIMIT 200`,
    )
      .bind(ecosystem, pkg)
      .all<BreakingChangeRow>();
    return rows.results ?? [];
  } catch {
    return [];
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
    if (Date.now() - new Date(row.fresh_at).getTime() > PAIR_TTL_MS) return null;
    const parsed = JSON.parse(row.response_json) as UpgradeCheckResult;
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
  for (const e of result.evidence.slice(0, 20)) {
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
  stmts.push(
    env.DB.prepare(
      `INSERT INTO source_snapshots (source, last_success_at) VALUES ('analysis', ?)
       ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at`,
    ).bind(result.freshness),
  );
  if (result.repository_url) {
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
  const breakingChanges = await loadBreakingChanges(env, req.ecosystem, req.package);
  const result = await analyzeUpgrade(req, { breakingChanges });
  result.analysis_version = env.ANALYSIS_VERSION;
  result.cache_hit = false;
  if (result.decision !== "unknown") {
    await savePair(env, req, result);
  }
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
