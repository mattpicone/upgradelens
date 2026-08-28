// Core deterministic upgrade-pair analysis. No LLM calls, ever.
// Every semantic claim carries evidence with source URL + timestamp.

import type {
  AdvisorySummary,
  Ecosystem,
  Evidence,
  UpgradeCheckRequest,
  UpgradeCheckResult,
  UpgradePlanResult,
  MigrationAction,
  SourceCoverage,
} from "../types";
import { classifyJump, compareVersions, isPrerelease } from "./semver";
import { classifyJumpPy, compareVersionsPy, isPrereleasePy } from "./pep440";
import { satisfiesRange } from "./semver";
import { satisfiesPySpec } from "./pep440";
import { fetchVersionDetail, type VersionDetail } from "../sources/registry";
import { fetchPackageVersions } from "../sources/depsdev";
import { queryOsvPair } from "../sources/osv";
import { cycleStatus, eolProductFor, fetchEol } from "../sources/endoflife";

export function cmpVersions(eco: Ecosystem, a: string, b: string): number | null {
  return eco === "npm" ? compareVersions(a, b) : compareVersionsPy(a, b);
}

export function jumpOf(eco: Ecosystem, from: string, to: string) {
  return eco === "npm" ? classifyJump(from, to) : classifyJumpPy(from, to);
}

export function isPre(eco: Ecosystem, v: string): boolean {
  return eco === "npm" ? isPrerelease(v) : isPrereleasePy(v);
}

// Small stable content hash for evidence IDs (not cryptographic).
export function evidenceId(...parts: string[]): string {
  const s = parts.join("|");
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 31) ^ c;
  }
  return "ev_" + ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
}

function ev(
  source_type: Evidence["source_type"],
  source_url: string,
  fact: string,
  fetched_at: string,
  confidence = 1.0,
): Evidence {
  return {
    id: evidenceId(source_type, source_url, fact),
    source_type,
    source_url,
    fact,
    confidence,
    fetched_at,
  };
}

export interface BreakingChangeRow {
  version: string;
  summary: string;
  severity: string;
  source_url: string;
  confidence: number;
  fetched_at: string;
}

export interface AnalyzeDeps {
  // Precomputed breaking changes between (from, to], loaded from D1 by caller.
  breakingChanges?: BreakingChangeRow[];
  breakingCoverage?: SourceCoverage;
}

const advisoryKey = (a: AdvisorySummary) => a.id;

export async function analyzeUpgrade(
  req: UpgradeCheckRequest,
  deps: AnalyzeDeps = {},
): Promise<UpgradeCheckResult> {
  const { ecosystem, package: pkg, current_version, target_version } = req;
  const now = new Date().toISOString();
  const evidence: Evidence[] = [];
  const reasons: string[] = [];
  let confidence = 0.95;

  // ---- Gather sources in parallel (4-7 external subrequests) ----
  const eolProduct = eolProductFor(ecosystem, pkg);
  const [pkgVersions, curDetail, tgtDetail, osv, eol] = await Promise.all([
    fetchPackageVersions(ecosystem, pkg),
    fetchVersionDetail(ecosystem, pkg, current_version),
    fetchVersionDetail(ecosystem, pkg, target_version),
    queryOsvPair(ecosystem, pkg, current_version, target_version),
    eolProduct ? fetchEol(eolProduct) : Promise.resolve(null),
  ]);
  const coverage: UpgradeCheckResult["coverage"] = {
    registry: {
      status: curDetail.ok && tgtDetail.ok ? "complete" : "unavailable",
      as_of: tgtDetail.fetched_at,
    },
    osv: {
      status: osv.current.ok && osv.target.ok ? "complete" : "unavailable",
      as_of: osv.current.fetched_at,
    },
    deps_dev: {
      status: pkgVersions.ok ? "complete" : "unavailable",
      as_of: pkgVersions.fetched_at,
    },
    eol: !eolProduct
      ? { status: "not_applicable", as_of: null }
      : eol?.ok
        ? { status: "complete", as_of: eol.fetched_at }
        : { status: "unavailable", as_of: eol?.fetched_at ?? null },
    breaking_changes: deps.breakingCoverage ?? {
      status: "not_covered",
      as_of: null,
      detail: "No maintained release-note coverage is available for this package.",
    },
  };

  // ---- Existence / availability ----
  const unknown = (why: string): UpgradeCheckResult => ({
    decision: "unknown",
    action_allowed: false,
    risk_score: 50,
    ecosystem,
    package: pkg,
    current_version,
    target_version,
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
    reasons: [why],
    claim_evidence: [],
    evidence,
    coverage,
    confidence: 0.3,
    freshness: now,
    analysis_version: "",
  });

  if (!tgtDetail.ok && tgtDetail.status === 404) {
    // Definitive: the target version does not exist.
    const result = unknown("");
    result.decision = "block";
    result.risk_score = 95;
    result.reasons = [
      `Target version ${target_version} was not found in the ${ecosystem} registry.`,
    ];
    result.confidence = 0.9;
    evidence.push(
      ev(
        "registry",
        tgtDetail.url,
        `HTTP 404 for ${pkg}@${target_version}`,
        tgtDetail.fetched_at,
      ),
    );
    result.claim_evidence = [{ claim: result.reasons[0]!, evidence_ids: [evidence.at(-1)!.id] }];
    return result;
  }
  if (!tgtDetail.ok || !tgtDetail.data) {
    return unknown(
      `Registry data for ${pkg}@${target_version} is unavailable (${tgtDetail.error ?? "fetch failed"}). Returning unknown rather than guessing.`,
    );
  }
  if (!curDetail.ok || !curDetail.data) {
    return unknown(
      `Registry data for the current version ${pkg}@${current_version} is unavailable (${curDetail.error ?? "fetch failed"}); dependency, license and compatibility deltas cannot be verified.`,
    );
  }

  const tgt = tgtDetail.data;
  const cur: VersionDetail = curDetail.data;

  // ---- Version facts ----
  const versionList = pkgVersions.ok ? (pkgVersions.data?.versions ?? []) : [];
  if (!pkgVersions.ok) confidence -= 0.1;
  else {
    evidence.push(
      ev(
        "deps_dev",
        pkgVersions.data!.source_url,
        `deps.dev lists ${versionList.length} versions for ${pkg}; default (latest) is ${pkgVersions.data!.default_version ?? "unknown"}.`,
        pkgVersions.fetched_at,
      ),
    );
  }
  const stableVersions = versionList.filter((v) => !isPre(ecosystem, v.version));
  const latest_stable =
    stableVersions.length > 0
      ? stableVersions.reduce((best, v) =>
          (cmpVersions(ecosystem, v.version, best.version) ?? -1) > 0 ? v : best,
        ).version
      : (pkgVersions.data?.default_version ?? null);

  const cmp = cmpVersions(ecosystem, current_version, target_version);
  const is_downgrade = cmp !== null && cmp > 0;
  const jump = jumpOf(ecosystem, current_version, target_version);

  const findPublished = (version: string): string | null =>
    versionList.find((v) => v.version === version)?.published_at ?? null;
  const current_published_at = findPublished(current_version) ?? cur.published_at ?? null;
  const target_published_at = findPublished(target_version) ?? tgt.published_at ?? null;

  let versions_between: number | null = null;
  if (versionList.length > 0 && cmp !== null) {
    const lo = is_downgrade ? target_version : current_version;
    const hi = is_downgrade ? current_version : target_version;
    versions_between = versionList.filter((v) => {
      const a = cmpVersions(ecosystem, v.version, lo);
      const b = cmpVersions(ecosystem, v.version, hi);
      return a !== null && b !== null && a > 0 && b < 0;
    }).length;
  }

  evidence.push(
    ev(
      "registry",
      tgt.source_url,
      `${pkg}@${target_version}: yanked=${tgt.yanked}, runtime_requirement=${tgt.runtime_requirement ?? "none"}, license=${tgt.license ?? "unknown"}${tgt.deprecated_message ? `, deprecated: ${tgt.deprecated_message.slice(0, 120)}` : ""}`,
      tgt.fetched_at,
    ),
  );
  evidence.push(
    ev(
      "registry",
      cur.source_url,
      `${pkg}@${current_version}: yanked=${cur.yanked}, runtime_requirement=${cur.runtime_requirement ?? "none"}, license=${cur.license ?? "unknown"}`,
      cur.fetched_at,
    ),
  );

  // ---- Security delta (OSV) ----
  let advCurrent: AdvisorySummary[] = [];
  let advTarget: AdvisorySummary[] = [];
  let osvOk = true;
  if (osv.current.ok && osv.target.ok) {
    advCurrent = osv.current.data ?? [];
    advTarget = osv.target.data ?? [];
    evidence.push(
      ev(
        "osv",
        `https://osv.dev/list?ecosystem=${ecosystem === "npm" ? "npm" : "PyPI"}&q=${encodeURIComponent(pkg)}`,
        `OSV: ${advCurrent.length} advisories affect ${pkg}@${current_version}; ${advTarget.length} affect ${pkg}@${target_version}.`,
        osv.current.fetched_at,
      ),
    );
  } else {
    osvOk = false;
    confidence -= 0.15;
    reasons.push("OSV vulnerability data was unavailable; security delta is incomplete.");
  }
  const targetIds = new Set(advTarget.map(advisoryKey));
  const currentIds = new Set(advCurrent.map(advisoryKey));
  const fixed = advCurrent.filter((a) => !targetIds.has(a.id));
  const introduced = advTarget.filter((a) => !currentIds.has(a.id));
  const remaining = advTarget;
  for (const a of [...fixed, ...introduced]) {
    evidence.push(
      ev("osv", a.url, `${a.id}${a.summary ? `: ${a.summary.slice(0, 160)}` : ""}`, now),
    );
  }

  // ---- Runtime compatibility ----
  const runtime_notes: string[] = [];
  let runtime_supported: boolean | null = null;
  let runtimeUnverified = false;
  const runtimeVersion = ecosystem === "npm" ? req.runtime?.node : req.runtime?.python;
  if (tgt.runtime_requirement) {
    runtime_notes.push(
      `${ecosystem === "npm" ? "Node" : "Python"} requirement of target: ${tgt.runtime_requirement}`,
    );
    if (runtimeVersion) {
      runtime_supported =
        ecosystem === "npm"
          ? satisfiesRange(runtimeVersion, tgt.runtime_requirement)
          : satisfiesPySpec(runtimeVersion, tgt.runtime_requirement);
      if (runtime_supported === false) {
        runtime_notes.push(
          `Provided runtime ${runtimeVersion} does NOT satisfy target requirement ${tgt.runtime_requirement}.`,
        );
      } else if (runtime_supported === null) {
        runtime_notes.push(`Could not evaluate requirement expression against ${runtimeVersion}.`);
        confidence -= 0.05;
        runtimeUnverified = jump !== "none";
      }
    } else {
      runtime_notes.push("No runtime version provided by caller; compatibility not verified.");
      runtimeUnverified = jump !== "none";
    }
  } else {
    runtime_notes.push("Target declares no runtime requirement.");
    runtime_supported = runtimeVersion ? true : null;
  }
  if (cur.runtime_requirement && tgt.runtime_requirement && cur.runtime_requirement !== tgt.runtime_requirement) {
    runtime_notes.push(
      `Runtime requirement changed: "${cur.runtime_requirement}" -> "${tgt.runtime_requirement}".`,
    );
  }

  // ---- Dependency delta (direct deps from registry metadata) ----
  let dependency_changes: UpgradeCheckResult["compatibility"]["dependency_changes"] = null;
  const before = cur.dependencies;
  const after = tgt.dependencies;
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after)
    .filter((k) => k in before && before[k] !== after[k])
    .map((k) => ({ name: k, from: before[k] ?? "", to: after[k] ?? "" }));
  dependency_changes = { added, removed, changed };
  if (added.length + removed.length + changed.length > 0) {
    evidence.push(
      ev(
        "registry",
        tgt.source_url,
        `Direct dependency delta ${current_version}->${target_version}: +${added.length} added, -${removed.length} removed, ~${changed.length} constraint changes.`,
        tgt.fetched_at,
      ),
    );
  }

  // ---- License change ----
  const license_change =
    cur.license && tgt.license && cur.license !== tgt.license
      ? { from: cur.license, to: tgt.license }
      : null;

  // ---- EOL ----
  let eolFlag = false;
  if (eol && eol.ok && eol.data) {
    const status = cycleStatus(eol.data.cycles, target_version);
    if (status) {
      evidence.push(
        ev(
          "endoflife",
          eol.data.source_url,
          `endoflife.date: ${pkg} cycle ${status.cycle} EOL=${status.eol}${status.eol_date ? ` (${status.eol_date})` : ""}.`,
          eol.data.fetched_at,
        ),
      );
      if (status.eol === true) {
        eolFlag = true;
        reasons.push(
          `Target version belongs to cycle ${status.cycle}, which has reached end-of-life.`,
        );
      }
    }
  }

  // ---- Precomputed breaking changes within (from, to] ----
  const breaking = (deps.breakingChanges ?? []).filter((b) => {
    const lower = is_downgrade ? target_version : current_version;
    const upper = is_downgrade ? current_version : target_version;
    const gtLower = cmpVersions(ecosystem, b.version, lower);
    const leUpper = cmpVersions(ecosystem, b.version, upper);
    return gtLower !== null && leUpper !== null && gtLower > 0 && leUpper <= 0;
  });
  for (const b of breaking) {
    evidence.push(ev("github_release", b.source_url, b.summary.slice(0, 200), b.fetched_at, b.confidence));
  }

  // ---- Decision + risk ----
  let risk = 0;
  if (jump === "major") {
    risk += 35;
    reasons.push(
      ecosystem === "pypi"
        ? `First PEP 440 release segment changes (${current_version} -> ${target_version}); compatibility cannot be inferred from this ordering change.`
        : `Major version jump (${current_version} -> ${target_version}).`,
    );
  } else if (jump === "minor") risk += 10;
  else if (jump === "patch") risk += 2;
  if (isPre(ecosystem, target_version)) {
    risk += 15;
    reasons.push("Target is a prerelease version.");
  }
  if (is_downgrade) {
    risk += 25;
    reasons.push("Target is LOWER than the current version (downgrade).");
  }
  const zeroMajorMinor =
    ecosystem === "npm" && jump === "minor" && current_version.replace(/^v/, "").startsWith("0.");
  if (zeroMajorMinor) {
    risk += 20;
    reasons.push("Pre-1.0 npm minor releases may contain breaking changes and require review.");
  }
  risk += Math.min(introduced.length * 20, 45);
  if (introduced.length > 0) {
    reasons.push(
      `Upgrade INTRODUCES ${introduced.length} known ${introduced.length === 1 ? "advisory" : "advisories"}: ${introduced.map((a) => a.id).join(", ")}.`,
    );
  }
  if (remaining.length > 0 && introduced.length === 0) {
    risk += Math.min(remaining.length * 10, 25);
    reasons.push(
      `${remaining.length} known ${remaining.length === 1 ? "advisory" : "advisories"} still affect the target version: ${remaining.map((a) => a.id).join(", ")}.`,
    );
  }
  if (fixed.length > 0) {
    risk -= Math.min(fixed.length * 8, 20);
    reasons.push(
      `Upgrade fixes ${fixed.length} known ${fixed.length === 1 ? "advisory" : "advisories"}: ${fixed.map((a) => a.id).join(", ")}.`,
    );
  }
  if (tgt.yanked) {
    risk += 50;
    reasons.push("Target version is yanked/withdrawn in the registry.");
  }
  if (tgt.deprecated_message) {
    risk += 20;
    reasons.push(`Target version is deprecated: ${tgt.deprecated_message.slice(0, 160)}`);
  }
  if (eolFlag) risk += 20;
  if (runtime_supported === false) {
    risk += 40;
    reasons.push("Declared runtime does not satisfy the target's requirement.");
  }
  if (versions_between !== null && versions_between > 20) {
    risk += 8;
    reasons.push(`${versions_between} intermediate releases exist between the two versions.`);
  }
  if (dependency_changes) {
    const churn =
      dependency_changes.added.length +
      dependency_changes.removed.length +
      dependency_changes.changed.length;
    risk += Math.min(churn, 10);
  }
  risk += Math.min(
    breaking.filter((b) => b.severity === "high").length * 15 +
      breaking.filter((b) => b.severity !== "high").length * 8,
    30,
  );
  if (breaking.length > 0) {
    reasons.push(`${breaking.length} documented breaking change(s) exist in the upgrade range.`);
  }
  risk = Math.max(0, Math.min(100, risk));

  let decision: UpgradeCheckResult["decision"];
  if (tgt.yanked || runtime_supported === false || introduced.length > 0) {
    decision = "block";
  } else if (!osvOk || coverage.eol.status === "unavailable" || runtimeUnverified) {
    decision = "unknown";
  } else if (
    jump === "major" ||
    jump === "unknown" ||
    is_downgrade ||
    eolFlag ||
    tgt.deprecated_message !== null ||
    remaining.length > 0 ||
    breaking.length > 0 ||
    isPre(ecosystem, target_version) ||
    license_change !== null
    || zeroMajorMinor
    || coverage.deps_dev.status !== "complete"
    || (zeroMajorMinor && coverage.breaking_changes.status !== "complete")
  ) {
    decision = "review_required";
  } else {
    decision = "proceed";
  }
  if (jump === "none") reasons.push("Current and target versions are identical.");

  if (license_change) {
    reasons.push(`License changes from ${license_change.from} to ${license_change.to}.`);
  }
  if (decision === "proceed" && reasons.length === 0) {
    reasons.push(
      `${jump} upgrade with no blockers found in the sources that were successfully checked.`,
    );
  }
  if (decision === "unknown") risk = Math.max(risk, 50);

  const evidenceIdsForClaim = (claim: string): string[] => {
    const lower = claim.toLowerCase();
    const sourceTypes = lower.includes("advis") || lower.includes("osv")
      ? ["osv"]
      : lower.includes("end-of-life") || lower.includes("eol")
        ? ["endoflife"]
        : lower.includes("breaking")
          ? ["github_release"]
          : lower.includes("runtime") || lower.includes("license") || lower.includes("deprecated") || lower.includes("yanked")
            ? ["registry"]
            : ["registry", "deps_dev"];
    return evidence.filter((item) => sourceTypes.includes(item.source_type)).map((item) => item.id);
  };

  return {
    decision,
    action_allowed: decision === "proceed",
    risk_score: risk,
    ecosystem,
    package: pkg,
    current_version,
    target_version,
    latest_stable,
    repository_url: tgt.repository_url ?? cur?.repository_url ?? null,
    version_facts: {
      current_published_at,
      target_published_at,
      current_yanked: cur?.yanked ?? false,
      target_yanked: tgt.yanked,
      package_deprecated: tgt.deprecated_message !== null,
      target_deprecation_message: tgt.deprecated_message,
      is_downgrade,
      semver_jump: jump,
      versions_between,
    },
    security_delta: {
      advisories_affecting_current: advCurrent,
      advisories_fixed_by_target: fixed,
      advisories_affecting_target: remaining,
    },
    compatibility: {
      runtime_supported,
      runtime_notes,
      dependency_changes,
      license_change,
    },
    breaking_changes: breaking.map((b) => ({
      summary: b.summary,
      severity: b.severity,
      confidence: b.confidence,
      source_url: b.source_url,
    })),
    reasons,
    claim_evidence: reasons.map((claim) => ({ claim, evidence_ids: evidenceIdsForClaim(claim) })),
    evidence,
    coverage,
    confidence: Math.max(0.2, Math.round(confidence * 100) / 100),
    freshness: now,
    analysis_version: "",
  };
}

// ---- Migration plan built on top of a check result --------------------------

export function buildPlan(
  check: UpgradeCheckResult,
  repoUrl: string | null,
): UpgradePlanResult {
  const actions: MigrationAction[] = [];
  const changelog_urls: string[] = [];
  let order = 1;

  if (!check.action_allowed) {
    actions.push({
      order: order++,
      action: `Do not edit dependency files yet: decision is ${check.decision}. Resolve the blocking or insufficient-evidence reasons first, then run check_dependency_upgrade again.`,
      evidence_ids: check.evidence.map((e) => e.id),
    });
  }

  const registryUrl =
    check.ecosystem === "npm"
      ? `https://www.npmjs.com/package/${check.package}?activeTab=versions`
      : `https://pypi.org/project/${check.package}/${check.target_version}/`;
  changelog_urls.push(registryUrl);
  if (repoUrl && /github\.com|gitlab\.com/.test(repoUrl)) {
    changelog_urls.unshift(`${repoUrl.replace(/\/$/, "")}/releases`);
  }

  const evIds = (pred: (e: { source_type: string }) => boolean) =>
    check.evidence.filter(pred).map((e) => e.id);

  for (const bc of check.breaking_changes) {
    actions.push({
      order: order++,
      action: `Address documented breaking change: ${bc.summary}`,
      evidence_ids: check.evidence
        .filter((e) => e.source_url === bc.source_url)
        .map((e) => e.id),
    });
  }
  if (check.version_facts.semver_jump === "major" && check.breaking_changes.length === 0) {
    actions.push({
      order: order++,
      action: `Major version upgrade: review the release notes/changelog between ${check.current_version} and ${check.target_version} before editing dependency files (${changelog_urls[0]}).`,
      evidence_ids: evIds((e) => e.source_type === "deps_dev" || e.source_type === "registry"),
    });
  }
  if (check.compatibility.runtime_supported === false) {
    actions.push({
      order: order++,
      action: `Upgrade the runtime first: target requires ${check.compatibility.runtime_notes[0] ?? "a newer runtime"}.`,
      evidence_ids: evIds((e) => e.source_type === "registry"),
    });
  }
  const depc = check.compatibility.dependency_changes;
  if (depc && depc.added.length + depc.removed.length + depc.changed.length > 0) {
    const parts: string[] = [];
    if (depc.added.length) parts.push(`adds ${depc.added.join(", ")}`);
    if (depc.removed.length) parts.push(`removes ${depc.removed.join(", ")}`);
    if (depc.changed.length)
      parts.push(
        `changes constraints for ${depc.changed.map((c) => c.name).join(", ")}`,
      );
    actions.push({
      order: order++,
      action: `Reconcile direct dependency changes: target ${parts.join("; ")}. Reinstall and verify the lockfile.`,
      evidence_ids: evIds((e) => e.source_type === "registry"),
    });
  }
  for (const a of check.security_delta.advisories_affecting_target) {
    actions.push({
      order: order++,
      action: `Known advisory ${a.id} still affects the target version — evaluate exposure before proceeding (${a.url}).`,
      evidence_ids: evIds((e) => e.source_type === "osv"),
    });
  }
  if (check.compatibility.license_change) {
    actions.push({
      order: order++,
      action: `Verify license compatibility: ${check.compatibility.license_change.from} -> ${check.compatibility.license_change.to}.`,
      evidence_ids: evIds((e) => e.source_type === "registry"),
    });
  }
  if (check.action_allowed) {
    actions.push({
      order: order++,
      action:
        check.ecosystem === "npm"
          ? `Update the version constraint in package.json to ${check.target_version}, reinstall, then run the project's test suite.`
          : `Update the version constraint (requirements/pyproject) to ${check.target_version}, reinstall, then run the project's test suite.`,
      evidence_ids: [],
    });
  }

  return { ...check, migration_actions: actions, changelog_urls };
}
