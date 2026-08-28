// find_safe_upgrade_target: rank candidate versions above the current one.

import type { Ecosystem, Evidence, FindTargetResult, TargetCandidate } from "../types";
import { cmpVersions, isPre, jumpOf, evidenceId } from "./analyze";
import { fetchPackageVersions } from "../sources/depsdev";
import { fetchJson } from "../sources/fetch";

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };

interface BatchResult {
  results: { vulns?: { id: string }[] }[];
}

export async function findSafeTarget(
  ecosystem: Ecosystem,
  pkg: string,
  currentVersion: string,
  opts: { maxMajorJump?: number; allowPrerelease?: boolean } = {},
): Promise<FindTargetResult> {
  const now = new Date().toISOString();
  const evidence: Evidence[] = [];
  const base: FindTargetResult = {
    ecosystem,
    package: pkg,
    current_version: currentVersion,
    latest_stable: null,
    candidates: [],
    evidence,
    confidence: 0.9,
    freshness: now,
    analysis_version: "",
  };

  const listing = await fetchPackageVersions(ecosystem, pkg);
  if (!listing.ok || !listing.data) {
    base.confidence = 0.3;
    return base;
  }
  evidence.push({
    id: evidenceId("deps_dev", listing.data.source_url, "versions"),
    source_type: "deps_dev",
    source_url: listing.data.source_url,
    fact: `deps.dev lists ${listing.data.versions.length} versions; default is ${listing.data.default_version ?? "unknown"}.`,
    confidence: 1,
    fetched_at: listing.fetched_at,
  });

  const allowPre = opts.allowPrerelease ?? isPre(ecosystem, currentVersion);
  const newer = listing.data.versions
    .filter((v) => {
      const c = cmpVersions(ecosystem, v.version, currentVersion);
      if (c === null || c <= 0) return false;
      if (!allowPre && isPre(ecosystem, v.version)) return false;
      return true;
    })
    .sort((a, b) => (cmpVersions(ecosystem, a.version, b.version) ?? 0) * -1);

  const stable = listing.data.versions.filter((v) => !isPre(ecosystem, v.version));
  base.latest_stable =
    stable.length > 0
      ? stable.reduce((best, v) =>
          (cmpVersions(ecosystem, v.version, best.version) ?? -1) > 0 ? v : best,
        ).version
      : null;

  if (newer.length === 0) {
    base.candidates = [];
    return base;
  }

  // Candidate selection: newest patch in current major.minor, newest in current
  // major, newest of each higher major (bounded), newest overall.
  const majorOf = (v: string) => v.replace(/^v/, "").split(".")[0] ?? "";
  const minorKey = (v: string) => {
    const p = v.replace(/^v/, "").split(".");
    return `${p[0] ?? ""}.${p[1] ?? ""}`;
  };
  const curMajor = majorOf(currentVersion);
  const curMinorKey = minorKey(currentVersion);
  const picked = new Map<string, { version: string; published_at: string | null }>();

  const newestWhere = (pred: (v: string) => boolean) =>
    newer.find((v) => pred(v.version)) ?? null;

  const samePatch = newestWhere((v) => minorKey(v) === curMinorKey);
  if (samePatch) picked.set(samePatch.version, samePatch);
  const sameMajor = newestWhere((v) => majorOf(v) === curMajor);
  if (sameMajor) picked.set(sameMajor.version, sameMajor);
  const majors = [...new Set(newer.map((v) => majorOf(v.version)))]
    .filter((m) => m !== curMajor)
    .slice(0, 3);
  const maxMajorJump = opts.maxMajorJump ?? Infinity;
  for (const m of majors) {
    if (Number(m) - Number(curMajor) > maxMajorJump) continue;
    const newest = newestWhere((v) => majorOf(v) === m);
    if (newest) picked.set(newest.version, newest);
  }
  const newestOverall = newer[0];
  if (newestOverall && picked.size < 5) picked.set(newestOverall.version, newestOverall);

  const candidates = [...picked.values()].slice(0, 5);

  // One OSV batch call: current + all candidates.
  const osvUrl = "https://api.osv.dev/v1/querybatch";
  const versionsToQuery = [currentVersion, ...candidates.map((c) => c.version)];
  const osvRes = await fetchJson<BatchResult>(osvUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: versionsToQuery.map((version) => ({
        package: { name: pkg, ecosystem: OSV_ECOSYSTEM[ecosystem] },
        version,
      })),
    }),
    timeoutMs: 8000,
  });

  let vulnsByVersion: Map<string, string[]> = new Map();
  if (osvRes.ok && osvRes.data) {
    versionsToQuery.forEach((v, i) => {
      vulnsByVersion.set(v, (osvRes.data!.results[i]?.vulns ?? []).map((x) => x.id));
    });
    evidence.push({
      id: evidenceId("osv", osvUrl, pkg + versionsToQuery.join(",")),
      source_type: "osv",
      source_url: `https://osv.dev/list?q=${encodeURIComponent(pkg)}`,
      fact: `OSV batch query across ${versionsToQuery.length} versions of ${pkg}.`,
      confidence: 1,
      fetched_at: osvRes.fetched_at,
    });
  } else {
    base.confidence = 0.6;
  }

  const currentVulns = new Set(vulnsByVersion.get(currentVersion) ?? []);

  const ranked: TargetCandidate[] = candidates.map((c) => {
    const vulns = new Set(vulnsByVersion.get(c.version) ?? []);
    const fixes = [...currentVulns].filter((id) => !vulns.has(id));
    const introduces = [...vulns].filter((id) => !currentVulns.has(id));
    const jump = jumpOf(ecosystem, currentVersion, c.version);
    const majorDistance = Math.max(0, Number(majorOf(c.version)) - Number(curMajor)) || 0;

    let score = 60;
    score += Math.min(fixes.length * 15, 30);
    score -= introduces.length * 40;
    score -= majorDistance * 12;
    if (jump === "patch") score += 15;
    else if (jump === "minor") score += 8;
    if (isPre(ecosystem, c.version)) score -= 25;
    if (vulns.size === 0) score += 10;
    score = Math.max(0, Math.min(100, score));

    const rationale: string[] = [];
    if (fixes.length) rationale.push(`fixes ${fixes.length} advisories (${fixes.join(", ")})`);
    if (introduces.length)
      rationale.push(`introduces ${introduces.length} advisories (${introduces.join(", ")})`);
    if (vulns.size === 0) rationale.push("no known advisories affect this version");
    rationale.push(`${jump} jump from ${currentVersion}`);

    const decision: TargetCandidate["decision"] =
      introduces.length > 0
        ? "block"
        : jump === "major"
          ? "review_required"
          : "proceed";

    return {
      version: c.version,
      score,
      decision,
      rationale,
      fixes_advisories: fixes,
      introduces_advisories: introduces,
      semver_jump: jump,
      published_at: c.published_at,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  base.candidates = ranked;
  return base;
}
